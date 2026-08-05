# A versioned workflow state machine in application code and Postgres rows

WayClub's approval engine is a configuration-driven state machine that lives entirely in the application and its database. No Temporal, no Camunda, no external workflow service. Human approval workflows are measured in days; they do not need durable-execution infrastructure. They need explicit states, conditional routing, deadlines, idempotent transitions, an audit trail and version pinning, and all of those live naturally in Postgres rows.

This document describes the engine as built in the private repository: schema in `infra/postgres/migrations/004_events_and_workflow.sql`, the guarded transition function in `007_app_helpers.sql`, policies in `008_rls_and_grants.sql`, re-routing in `010`, a stage-order backstop in `013`, submission snapshots and reviewer delegation in `030`, the standalone branch in `032`, behaviour in `docs/WORKFLOWS.md`, reasoning in ADR-0004.

## Definitions are data, versions are immutable

A workflow definition is a row whose published versions are separate rows holding an immutable JSONB snapshot:

```jsonc
{
  "key": "event_off_campus",
  "version": 1,
  "stages": [
    { "key": "advisor_endorsement",   "name": "Advisor endorsement",   "assigneeRole": "advisor",      "order": 1 },
    { "key": "student_life_approval", "name": "Student LIFE approval", "assigneeRole": "student_life", "order": 2 },
    { "key": "safety_review",         "name": "Safety review",         "assigneeRole": "safety",       "order": 3, "parallelGroup": "g3" },
    { "key": "facilities_review",     "name": "Facilities review",     "assigneeRole": "facilities",   "order": 3, "parallelGroup": "g3",
      "condition": { "field": "venueManaged", "equals": true } }
  ],
  "conditions": { "appliesWhen": { "isOffCampus": true } }
}
```

Editing a definition creates a new version row; published versions are never mutated, and there is deliberately no update policy on the versions table or an update grant to the request role.

**Four definition keys ship with the seed, and definitions are per account**, so each key exists once per account that uses it:

1. **`event_low_risk`**: advisor endorsement, then Student LIFE approval. The default institution route.
2. **`event_off_campus`**: advisor, then Student LIFE, then safety review, parallel with facilities review when the venue is institution-managed.
3. **`event_budget_threshold`**: the otherwise-applicable route plus a finance stage when the estimated budget meets the account's configured threshold. Conditions compose, so an off-campus event over the threshold gets the off-campus route plus finance.
4. **`club_internal_review`**: a committee check decided by the president, then a courtesy advisor endorsement. This is the route a standalone club takes, because it has no institution and therefore no institutional reviewers.

Route selection reads the submitted event's `isOffCampus`, its server-derived `riskLevel` and its budget. The account's governance mode is read **first** and fails closed: a standalone account routes internally and never through an institution route, and a missing internal template is an honest conflict error rather than a silent fallthrough.

## Instances pin their version forever

An instance records the definition key and version at start and interprets that version until it closes. Publishing version 2 of a route never migrates in-flight instances; they finish under the rules they started under. The audit trail names the definition version on every decision, so any historical decision can be replayed against the rules that governed it. When a university asks why an event skipped the facilities stage in March, the answer is in the data rather than in a git archaeology session.

A partial unique index adds a small but load-bearing guarantee:

```sql
create unique index uq_workflow_instance_running
  on public.workflow_instance (event_id) where state = 'running';
```

One running instance per event, ever, enforced by the database rather than by careful application sequencing.

## Routing is re-evaluated on every resubmission, and that was learned the hard way

This is the single most important behaviour in the engine, and it exists because an adversarial review broke the original.

Routing used to be selected once, at first submission. An organiser could therefore take an event approved on the low-risk route, edit it during a revision cycle into an off-campus, high-risk, over-threshold event, resubmit, and keep the original two-stage route. Safety, facilities and finance never saw it. The reviewer's control case made it unarguable: the same content submitted fresh produced five approval stages; smuggled through a revision it produced two.

The fix could not simply re-point the instance at a new definition, because pinning is what makes an approval auditable. So on every resubmission the engine re-selects the definition against the event as it now is, and:

- if the required definition is unchanged, the instance continues, with newly-required stages added;
- if it has changed, the running instance is marked **`superseded`**, a state added specifically for this, and a new instance is opened pinned to the newly-selected version. `cancelled` was not reused, because a superseded route was not cancelled by anyone;
- approvals granted before a later edit are re-opened for re-review.

Two related defects were closed at the same time and are worth naming, because both were failures of the same kind. `riskLevel` was not a routing input at all, and the web and server risk questionnaires had drifted onto disjoint key sets, so a high-risk event submitted from the browser derived as low risk on the server. The question set now has one canonical definition, pinned by a test that imports both sides. And a missing budget threshold made the finance comparison `NaN`, which is always false, so a newly-onboarded institution silently lost financial oversight on every event. **Configuration gaps now fail closed**: a missing threshold requires finance review for any non-zero budget. Skipping a mandatory approval is never the safe default.

## Idempotency is structural, not behavioural

Approve must be idempotent and a double decision must be impossible under concurrency, retries and impatient double-clicks. Rather than encode that in application logic every future endpoint must remember, the schema makes the illegal states unrepresentable:

- **One decision record per stage** is a `unique` constraint on the approval's stage reference. A second decision is a `23505` at the constraint level, whatever the application does.
- **A decided stage is immutable by policy shape.** The only update policy on the stage table admits rows where the status is still pending. Once decided, the row matches no policy and cannot be touched again, including by the reviewer who decided it.
- **Decisions cannot be misattributed.** The policy's `WITH CHECK` requires the decider to be the caller, and inserting the approval row requires a subquery proving the referenced stage was decided by this actor with this exact decision. You cannot record an approval on somebody else's behalf.
- **A check constraint keeps decided and pending states coherent**: pending or skipped stages carry no decider and no timestamp; decided stages always carry both.
- **Comments are required where they matter.** A rejection or change request without an explanation is a constraint violation, not a UX oversight.

The API's semantics sit on top: repeating an approve of a stage the same user already approved is a no-op, and a decision conflicting with another user's returns a version conflict. The database guarantees the invariant either way.

## Revision cycles append, and the reviewer sees the diff

When a reviewer requests changes the event becomes editable again. On resubmission, decided stage rows are not reset. New stage rows are inserted with the same key and an incremented attempt counter, under `unique (instance_id, key, attempt)`. Nothing is overwritten: the first attempt's decision, decider and timestamp survive as first-class rows.

Stages whose conditions evaluate false at instance creation are not omitted; they are inserted as `skipped`, so the instance is a complete auditable copy of the route taken, including the branches not taken.

Migration 030 added a submission snapshot table, written by trigger. The diff between the last two snapshots is computed on the server and rendered on the reviewer's screen as sentences rather than as a raw object: field-level changes such as a budget moving from one figure to another, risk-answer changes listed separately, and an explicit statement when a resubmission changed nothing at all. When the derived risk level itself moved, a warning fires above the list and says why it matters:

> The risk level moved from {old} to {new}, which changes who must approve this event.

The old value is struck through **and** the words "changed from … to" are present, so meaning never rides on styling alone.

## Delegation, without letting the queue become a loophole

A reviewer going away can delegate their queue to a named substitute for a bounded period. A substitute's decisions are stamped with the delegation they were made under and render as "as substitute for …" in the stage history, in a standing banner while the borrowed queue is held, and as a chip in the queue timeline.

Separation of duties is enforced twice, deliberately. The service refuses when the actor does not hold the stage's role in their own right and is also the person who submitted the event. A database trigger then stamps the delegation from live authority facts at decision time rather than from anything the client sent, applies the same rule, and refuses outright when the decider holds neither their own role nor a valid delegation. Holding a role in your own right always wins and stamps nothing, so a decision is never mislabelled as a substitution.

## "Current" stages are derived, never stored

There is no current-stage pointer to update, and that absence is a design decision. The current stages of an instance are the pending stages with the lowest order among pending stages; equal order plus a shared parallel group means genuine parallelism.

Because currency is a query rather than a mutation, deciding a stage requires no advancement write. Two reviewers deciding parallel stages in the same instant cannot race over a pointer; there is no pointer. The reviewer queue is served by an index directly on the stage table, so building the hot path needs no join to the event.

The stage-decision transaction is therefore small and safe: update the stage row, policy-checked; insert the approval row, constraint-checked; and where every non-skipped stage is now approved, close the instance and transition the event, all in one transaction with the audit events. Commit together or not at all.

## One door for lifecycle changes

Event status is server-owned across fifteen states. Committee members may edit event **fields** directly under RLS while the event is editable, with the policy's `WITH CHECK` pinning the status inside that same editable set. Every **status** change goes through a single `SECURITY DEFINER` function:

```sql
app.transition_event(event_id, to_status, expected_version) returns integer
```

It looks up the event within the caller's tenant, so missing and cross-tenant are the same typed 404; enforces optimistic concurrency; classifies the actor through the same helper predicates the policies use; and checks the requested edge against an explicit allow-list per actor class. A permitted actor on an illegal edge gets a conflict; a non-actor gets a permission error. The function bumps the version, and the audit trigger fires on the status change automatically. Migration 013 added a database-layer stage-order backstop so the order cannot be defeated from outside the API either.

Migration 032 fixed a real product hole in the same function. It recognised decision consequences only from institutional reviewer actors, so a standalone club's president could approve but could never send anything back: a check that cannot say no is not a check. The fix is one narrow branch gated on **both** the account's governance mode **and** the actor genuinely holding the assignee role of a stage on this event's route. The final approval step is still guarded by the requirement that every review stage is decided, so a standalone president cannot conjure the advisor's endorsement.

Typed SQLSTATE codes map one to one onto HTTP status codes, so the API layer translates without interpreting.

## What the tests pin down

The database suite (100 tests) exercises the engine directly against the database as the RLS-bound role: members cannot decide stages; the advisor can decide the advisor stage but not the Student LIFE stage; finance can decide the finance stage and Student LIFE cannot; a decided stage is immutable even to its decider; double-deciding violates the unique constraint; misattributed decisions are refused; illegal lifecycle jumps conflict; cross-tenant transition targets are indistinguishable 404s; stale versions conflict.

Above that, the API suite (640 tests against real Postgres) covers the re-routing rules, the standalone route end to end from draft to approved and back through request-changes and resubmit, delegation and its refusals, and the revision diff including two tenancy negatives. The engine's guarantees are test-pinned at the same layer that enforces them.
