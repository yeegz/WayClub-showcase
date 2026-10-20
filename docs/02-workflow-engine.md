# The workflow engine: one durable record, rules kept in rows

An event in WayClub is one durable record. The plan, any approval, registration, attendance, the photographs and the post-event report all attach to the same row, which moves through fifteen server-owned states from `draft` to `archived` (`infra/postgres/migrations/004_events_and_workflow.sql`). Nothing is re-keyed between steps. The committee workspace is built on the same idea: a meeting, its agenda, its decisions and the tasks that follow from them are one record with a lifecycle of its own.

There is no Temporal, Camunda or other external workflow service. Approvals take days, not milliseconds; they need explicit states, conditional routing, deadlines, decisions that cannot be made twice, an audit trail and version pinning, and all of those fit in Postgres rows and transactions. The reasoning is ADR-0004 in the build repository. This document describes the engine as it stands in the migrations up to 057 and in `apps/api/src/workflow/workflow-engine.service.ts`.

## Most groups never see an approval

Whether an event needs a yes is a club setting, `club.publishing_policy`, added in migration 052:

- `none`: the committee publishes when the event is ready. This is the default for a new independent group.
- `approver`: one named approver, either the club's advisor or an office in an institution workspace, must say yes first.
- `legacy`: the routed, multi-stage review that an institution workspace uses by default, and that every club which existed before the setting keeps.

Publishing without review is an explicit policy, never an inferred absence of one. `app.transition_event` allows a draft to go straight to `registration_open` only when the club's policy is `none`, the event has no workflow instance other than cancelled or superseded ones, and the event is complete: a title, a summary, a place, a start and an end that is still ahead, and payment instructions whenever a fee is set.

## Definitions are data, and published versions never change

A workflow definition is a row, and each published version is a separate row holding an immutable JSONB document. The shape is documented in the header of `004_events_and_workflow.sql`, using an institution's route for off-campus events as the example:

```jsonc
{
  "key": "event_off_campus",
  "version": 1,
  "stages": [
    { "key": "advisor_endorsement",  "name": "Advisor endorsement",  "assigneeRole": "advisor",      "order": 1 },
    { "key": "student_life_approval","name": "Student LIFE approval","assigneeRole": "student_life", "order": 2 },
    { "key": "safety_review",        "name": "Safety review",        "assigneeRole": "safety",       "order": 3, "parallelGroup": "g3" },
    { "key": "facilities_review",    "name": "Facilities review",    "assigneeRole": "facilities",   "order": 3, "parallelGroup": "g3",
      "condition": { "field": "venueManaged", "equals": true } }
  ],
  "conditions": { "appliesWhen": { "isOffCampus": true } }
}
```

Stages open strictly in order; equal order in the same parallel group runs in parallel. A stage whose condition is false is still inserted, as `skipped`, so the instance is a complete copy of the route taken, including the branches not taken. The request role may insert and read definition versions and has no update grant on them.

Definitions are per account. In the seeded database each institution workspace holds `event_low_risk`, `event_off_campus`, `event_budget_threshold` and `club_single_approver`; each independent group holds `club_internal_review` (a committee check, then an advisor endorsement) and `club_single_approver`. The single-approver definition is created for an account by a trigger the first time a club is created in it.

## Choosing a route, and failing closed

For the routed review, selection reads the account's governance mode before any condition. An independent workspace routes through its internal template and never through an institution route, whose stages name reviewer roles it cannot hold. An institution workspace routes on the event itself: off-campus or high risk takes the escalated route with its safety stage, a budget at or over the configured threshold adds a finance stage, and the two compose.

Configuration gaps fail closed. A missing budget threshold once made the comparison `NaN`, which is always false, so a newly configured institution silently lost finance review on every event. Now a missing threshold requires finance review for any budget above zero. A missing template is an honest conflict error rather than a fall-through.

## Instances pin their version forever

An instance records the definition key and version it started under and interprets that version until it closes. Publishing version 2 never migrates instances in flight, and every decision names the version that governed it. A partial unique index allows one running instance per event, and a trigger from migration 052 refuses any update to an instance's definition, publishing policy, named approver or submitter: the configuration that governed a decision cannot be edited after the fact.

## Routing is re-checked on every resubmission

This rule exists because an adversarial review broke the original. Routing was chosen once, at first submission, so an organiser could take an event approved on the low-risk route, edit it during a revision into an off-campus, high-risk, over-budget event, resubmit, and keep the two-stage route. Safety, facilities and finance never saw it.

Pinning is what makes a decision auditable, so the fix could not simply re-point the instance. On every resubmission the engine selects a route against the event as it now is. If the required definition is unchanged, the instance continues with any newly required stages added. If it has changed, the running instance becomes `superseded`, a state added for exactly this, and a new instance opens pinned to the new version. Nothing is overwritten: each revision cycle inserts new stage rows with an incremented attempt under `unique (instance_id, key, attempt)`.

## Decisions are made impossible to repeat, not merely discouraged

- One decision per stage is a `unique` constraint on the approval's stage reference.
- The only update policy on a stage admits it while it is pending, so a decided stage is immutable, even to the person who decided it.
- The policy's `WITH CHECK` requires the decider to be the caller, so nobody can record a decision on someone else's behalf.
- A check constraint keeps pending and decided rows coherent, and another refuses a rejection or a request for changes without a comment.

There is no stored "current stage" pointer. The current stages are the pending stages with the lowest order, derived by query, so two reviewers deciding parallel stages at the same moment have nothing to race over.

## One door for status changes

Committee members may edit an event's fields while it is editable, but every status change goes through one `SECURITY DEFINER` function, `app.transition_event(event_id, to_status, expected_version)`. It finds the event inside the caller's account, so missing and cross-tenant are the same 404; checks the version for optimistic concurrency; classifies the caller as committee, reviewer or administrator; and checks the requested edge against an allow-list for that class. An event cannot be marked `reported` until a post-event report has been submitted.

A named approver cannot approve an event they created or submitted. A second review in October found that a named approver who also sat on the committee could request changes, resubmit, and approve their own resubmission. Migration 056 now records who submitted each attempt and refuses a decider who submitted the instance or the current attempt. Reviewers on a routed review can still hand their queue to a named substitute for a bounded time; the substitute's decisions are stamped "as substitute for", and a database trigger refuses a substitute deciding an event they submitted.

## The committee workspace, on the same footing

Migration 051 turned the meeting, agenda, decision and attendance tables into a working committee space, and migration 056 hardened it.

- Meetings are visible to the club's committee only, not to members and not to institution oversight.
- A meeting's status only moves forward: scheduled, held, minutes in draft, minutes approved. It can be cancelled only before approval.
- Only the president or the secretary can approve minutes, the approval is audited, and approved minutes are final: title, time, place, notes, agenda, decisions and attendance are all frozen.
- A decision can become exactly one follow-up task, bound by a composite key to the same club and account, and a task that came from a meeting stays visible to the committee only.
- A separate club activity log records closed, typed facts (a meeting created, a task updated) with no free-form detail field, so minutes cannot leak into it by accident.

On the organiser's side the fifteen event states collapse into four plain groups in the events pipeline: Being planned, Waiting for a yes, Published and Done (`apps/web/src/components/organise/event-words.ts`).

## What the engine deliberately does not do

There is no automatic approval edge for anything, human or otherwise, to occupy. The deadline sweep pressures people rather than replacing them: it sends reminders and escalations and writes audit rows with no human actor, and that is all it may do. Decisions are made online, by a person, every time.
