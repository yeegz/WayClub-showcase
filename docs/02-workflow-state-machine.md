# A versioned workflow state machine in application code and Postgres rows

WayClub's approval engine is a configuration-driven state machine that lives entirely in the application and its database. No Temporal, no Camunda, no external workflow service. Human approval workflows are measured in days; they do not need durable-execution infrastructure, they need explicit states, conditional routing, SLA timers, idempotent transitions, an audit trail and version pinning. All of those live naturally in Postgres rows.

This document describes the engine as built in the private repository: schema in `infra/postgres/migrations/004_events_and_workflow.sql`, the guarded transition function in `007_app_helpers.sql`, policies in `008_rls_and_grants.sql`, behavioural specification in `docs/WORKFLOWS.md`, reasoning in ADR-0004.

## Definitions are data, versions are immutable

A workflow definition is a row (`workflow_definition`, keyed per institution) whose published versions are separate rows (`workflow_definition_version`) holding an immutable JSONB snapshot:

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

Editing a definition creates a new version row; published versions are never mutated (there is deliberately no UPDATE policy on the versions table). Three definitions ship with the seed:

1. **event_low_risk**: advisor endorsement, then Student LIFE approval (the default route).
2. **event_off_campus**: advisor, then Student LIFE, then safety review, parallel with facilities review when the venue is institution-managed.
3. **event_budget_threshold**: the otherwise-applicable route plus a finance stage when the estimated budget reaches the institution's configured threshold. Conditions compose: an off-campus event over the threshold gets the off-campus route plus finance.

Route selection is conditional on the submitted event's `isOffCampus`, `riskLevel` and `estimatedBudgetCents`. Which brings us to the property the whole design hangs on.

## Instances pin their version forever

A `workflow_instance` records `definition_key` and `definition_version` at start and interprets that version until it closes. Publishing version 2 of a route never migrates in-flight instances; they finish under the rules they started under. Resubmission after a terminal rejection or expiry starts a fresh instance on the then-current version; resubmission within a revision cycle stays on the pinned one.

The audit trail names the definition version on every decision, so any historical decision can be replayed against the rules that governed it. When a university asks "why did this event skip the facilities stage in March", the answer is in the data, not in a git archaeology session.

A partial unique index adds a small but load-bearing guarantee:

```sql
create unique index uq_workflow_instance_running
  on public.workflow_instance (event_id) where state = 'running';
```

One running instance per event, ever, enforced by the database rather than by careful application sequencing.

## Idempotency is structural, not behavioural

Approve must be idempotent and double-decision must be impossible, under concurrency, retries and impatient double-clicks. Rather than encode this in application logic that every future endpoint must remember, the schema makes the illegal states unrepresentable:

- **One decision record per stage** is a `unique` constraint: `approval.stage_id` is declared `unique`. A second decision on the same stage is a `23505 unique_violation` at the constraint level, whatever the application does.
- **A decided stage is immutable by policy shape.** The only UPDATE policy on `workflow_stage` admits rows `WHERE status = 'pending'`. Once decided, the row matches no policy and cannot be touched again, including by the reviewer who decided it.
- **Decisions cannot be misattributed.** The policy's `WITH CHECK` requires `decided_by = auth.uid()`, and inserting the `approval` row requires a subquery proving the referenced stage was decided by this actor, with this exact decision. You cannot record an approval on someone else's behalf.
- **A CHECK constraint keeps decided and pending states coherent**: pending or skipped stages carry no decider and no timestamp; decided stages always carry both.
- **Comments are required where they matter**: `check (decision = 'approved' or (comment is not null and length(trim(comment)) > 0))`. A rejection or change request without an explanation is a constraint violation, not a UX oversight.

The API's semantics sit on top: repeating an approve of a stage the same user already approved returns 200 as a no-op; a decision conflicting with another user's returns 409 `state_conflict`. The database guarantees the invariant either way.

## Revision cycles are append-only attempts

When a reviewer requests changes, the event moves to `revision_requested` and becomes editable again. On resubmission, decided stage rows are not reset. Instead, the engine inserts **new** stage rows with the same key and `attempt + 1`, under:

```sql
unique (instance_id, key, attempt)
```

Nothing is ever overwritten: attempt 1's decision, decider and timestamp survive as first-class rows, and the reviewer sees the full history of every attempt. Stages previously approved remain approved unless the definition marks them re-review-on-change (the pilot default re-reviews the advisor and Student LIFE stages when submission content changes). Each submission snapshot is kept in `event_revision`, so reviewers get a side-by-side diff of what actually changed between attempts.

Stages whose conditions evaluate false at instance creation are not omitted; they are inserted with status `skipped`, so the instance is a complete, auditable copy of the route taken, including the branches not taken.

## "Current" stages are derived, never stored

There is no `current_stage_id` pointer to update, and that absence is a design decision. The current stages of an instance are defined as: the pending stages with the lowest `order_index` among pending stages (equal order plus a shared `parallelGroup` means genuine parallelism).

Because currency is a query rather than a mutation, deciding a stage requires no advancement write. Two reviewers deciding parallel stages in the same instant cannot race over a pointer; there is no pointer. The reviewer queue is served directly by an index on `(institution_id, assignee_role, status, sla_due_at)`.

The stage-decision transaction is therefore small and safe: update the stage row (policy-checked), insert the approval row (constraint-checked), and, where every non-skipped stage is now approved, close the instance and transition the event, all in one transaction with the audit events. Commit together or not at all.

## One door for lifecycle changes

Event status is server-owned across fifteen states (twelve mainline, three terminal side states). Committee members may edit event **fields** directly under RLS while the event is editable (`draft`, `internal_planning`, `revision_requested`), with the policy's `WITH CHECK` pinning status inside that set. Every **status** change goes through a single `SECURITY DEFINER` function:

```sql
app.transition_event(event_id, to_status, expected_version) returns integer
```

It looks up the event within the caller's tenant (missing and cross-tenant are the same `WC404`), enforces optimistic concurrency (`version <> expected` raises `WC409`), classifies the actor (committee of the club, reviewer in scope, university admin) through the same helper predicates the policies use, and checks the requested edge against an explicit allow-list of transitions per actor class. A permitted actor on an illegal edge gets `WC409 state_conflict`; a non-actor gets `WC403`. The function bumps `version`, and the audit trigger fires on the status change automatically.

Typed SQLSTATE codes (`WC401`, `WC403`, `WC404`, `WC409`) map one-to-one onto HTTP 401/403/404/409, so the API layer translates without interpreting.

## What the tests pin down

The foundation suite in the private repo (29 tests, `infra/postgres/tests/wayclub-db.test.mjs`) exercises this engine directly against the database as the RLS-bound role: members cannot decide stages; the advisor can decide the advisor stage but not the Student LIFE stage; finance can decide the finance stage and Student LIFE cannot; a decided stage is immutable even to its decider; double-deciding violates the unique constraint; misattributed decisions are refused; illegal lifecycle jumps return `WC409`; cross-tenant transition targets return `WC404`; stale versions conflict. The engine's guarantees are test-pinned at the same layer that enforces them.
