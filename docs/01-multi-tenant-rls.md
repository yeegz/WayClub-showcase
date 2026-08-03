# Multi-tenant isolation with Postgres row-level security

WayClub hosts many institutions in one database. Cross-tenant information disclosure is the critical risk in its threat model, so tenancy is enforced at the layer a forgotten application check cannot reach: the database itself. This document describes the mechanism as it exists in the private build repository (migrations `infra/postgres/migrations/001_extensions_and_auth.sql` through `008_rls_and_grants.sql`, tests in `infra/postgres/tests/wayclub-db.test.mjs`).

The design position, recorded in ADR-0002 of the build repo, is blunt: application-level `WHERE institution_id = ?` filtering alone fails open, because one forgotten predicate is a breach. With row-level security as the floor, a forgotten application check degrades to an empty result or a 404, never a leak.

## Three database roles, one of which handles requests

| Role | Powers | Used by |
|---|---|---|
| `wayclub_admin` | LOGIN; owns every object | Migrations and seeds only |
| `wayclub_app` | LOGIN; owns nothing, no BYPASSRLS | Every normal API request; RLS binds it unconditionally |
| `wayclub_service` | LOGIN with BYPASSRLS | Narrowly-scoped, audited jobs (waitlist promotion, SLA sweeps); never request handling |

Because `wayclub_app` is not a table owner and holds no bypass attribute, there is no code path in request handling where RLS is off. "No service role in request paths" is enforced by connection string, not by discipline. The separation deliberately mirrors hosted Supabase's own posture (`postgres` / `authenticated` / `service_role`), which keeps a later hosted migration clean.

## The Supabase-shaped shim

Rather than invent a session-identity mechanism, the local Postgres carries a minimal `auth` schema shaped exactly like hosted Supabase:

```sql
create function auth.jwt() returns jsonb
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;

create function auth.uid() returns uuid
language sql stable
as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$$;
```

Per request, the API verifies the session JWT, opens a transaction as `wayclub_app`, and runs:

```sql
select set_config('request.jwt.claims', $claims_json, true);
```

The third argument makes the setting transaction-local. That single boolean carries a lot of weight: with pooled connections, a connection-local setting would leak one user's identity into the next request. Transaction-local scoping means identity and the work it authorises commit or vanish together.

The JWT claims include `institution_id`, surfaced to policies through a helper:

```sql
create function app.current_institution_id() returns uuid
language sql stable security definer set search_path = ''
as $$
  select (auth.jwt() ->> 'institution_id')::uuid
$$;
```

Because the shim matches the hosted contract (`auth.users`, `auth.uid()`, `auth.jwt()`, the `request.jwt.claims` GUC), adopting hosted Supabase later is a connection-string swap, not a policy rewrite.

## Deny-by-default, in two layers

Migration `008_rls_and_grants.sql` enables RLS on 57 tables, then writes policies only for the tables the pilot slice actually reaches. The interesting part is what happens to the rest.

The schema is deliberately broad (79 tables across 21 migrations: venues, budgets, meetings, tasks, files and more, modelled now so the domain model is honest about where the product is going). Thirty-one of those tables are "breadth" tables with no API surface yet. They get:

- RLS enabled, with **no policies**: in Postgres, RLS with no policy denies everything.
- **No grants** to `wayclub_app` at all.

So access to an unbuilt table fails twice: first at the grant layer (`42501 insufficient_privilege`), then, even if a grant were mistakenly added, at the policy layer. A future migration must add explicit policies and grants in the same change before any of these tables becomes reachable. The safe state is the default state.

For tables that do have policies, the shape is consistent: every policy tests tenancy **and** a relationship, and write policies are separate from and stricter than read policies:

```sql
create policy event_select on public.event
  for select to wayclub_app
  using (
    institution_id = app.current_institution_id()
    and (
      app.is_committee_of(club_id)
      or app.is_member_of(club_id)
      or created_by = auth.uid()
      or app.is_reviewer_for_club(club_id)
      or app.is_university_admin()
      or (status in ('approved','scheduled','registration_open','live','completed')
          and deleted_at is null)
    )
  );
```

Two patterns worth noting:

- **`USING` and `WITH CHECK` do different jobs.** The committee's event UPDATE policy uses `USING` to admit only editable states (`draft`, `internal_planning`, `revision_requested`) and `WITH CHECK` to pin the resulting row inside that same set, so no direct UPDATE can move an event through its lifecycle. Lifecycle changes have exactly one path, a guarded `SECURITY DEFINER` function (see the workflow deep dive).
- **Relationship predicates live in `SECURITY DEFINER` helper functions** (`app.is_member_of`, `app.is_committee_of`, `app.holds_stage_role`, and so on), owned by `wayclub_admin` with `search_path` pinned to `''`. A policy on table A can consult tables B and C through them without recursively triggering B's and C's own RLS, and the helpers are locked down with `REVOKE ... FROM public` plus explicit `EXECUTE` grants.

Separation of duties is encoded in the same layer. A club president can insert `role_assignment` rows only for club-scoped committee roles in their own club; granting reviewer or institution roles requires a university administrator. A president cannot promote themself into their own approval chain, and the policy, not a code review convention, says so.

## The denormalised `club_id` decision

The workflow tables (`workflow_instance`, `workflow_stage`, `approval`, `approval_comment`), plus `event_registration`, `waitlist_entry` and `attendance`, all carry a `club_id` column copied from their event, alongside the `institution_id` every tenant-scoped table carries. Migration `004_events_and_workflow.sql` marks these columns "denormalised for RLS" explicitly.

Why duplicate a derivable value?

- **Policies stay flat.** The stage-decision policy needs "does the caller hold this stage's assignee role, in scope for this club". With `club_id` on the row, that is one helper call. Without it, every policy evaluation on every workflow row would join through `event`, which multiplies policy cost across queue queries and makes the policies harder to read and review.
- **Queues stay indexable.** The reviewer queue is served by an index on `(institution_id, assignee_role, status, sla_due_at)` directly on `workflow_stage`. No join to `event` is needed to build the hot path.
- **Consistency is enforced at write time**, not assumed. The INSERT policies carry `WITH CHECK` subqueries proving the denormalised values agree with the parent row. For example, inserting a `workflow_stage` requires an existing `workflow_instance` with the same `event_id`, `club_id` and `institution_id`; inserting an `approval` requires the referenced stage to be decided, by this actor, with this decision, with all four identifiers matching. A row with lying denormalised columns cannot be created through the RLS-bound role.

The trade is honest: a few duplicated UUID columns and slightly wordier insert checks, in exchange for policies that are cheap, auditable at a glance, and free of recursive evaluation.

## The generic cross-tenant denial test

Per-table tests rot: someone adds a table and forgets the test. The build repo's isolation suite instead discovers the surface mechanically:

```js
const { rows: tables } = await admin.query(`
  select table_name
  from information_schema.columns
  where table_schema = 'public' and column_name = 'institution_id'
  order by table_name
`);
expect(tables.length).toBeGreaterThan(40); // the whole domain, not a subset
```

Then, as a Sunway-tenant user, it attempts a cross-tenant `SELECT` and a cross-tenant `UPDATE` against **every** discovered table, accepting only two outcomes: zero rows, or `42501`. The floor assertion (`> 40`) means a refactor cannot quietly shrink the tested surface; any new table that carries `institution_id` is inside the net the moment it is created.

Around that core, the suite adds the checks that keep the generic test honest:

- **Symmetry**: a Meridian-tenant user sees no Sunway rows either, on a sample of hot tables.
- **Positive controls**: the same personas do see their own tenant's rows, so a broken policy that denies everything cannot masquerade as passing isolation.
- **INSERT smuggling**: inserting a row that claims the other tenant's `institution_id` is refused by `WITH CHECK`.
- **The tenant list itself is invisible**: `select id from public.institution` returns exactly the caller's own institution.

The seed ships three tenants for exactly this purpose: "Sunway Pilot (unofficial demo)" and the fully fictional "Meridian University", so the denial tests always have a second tenant to fail to read, plus "Aurora Film Society", a standalone club account belonging to no university at all. The third one matters: it proves the tenant boundary is the account rather than the institution, and that a club with no institution cannot acquire one.

## 404, indistinguishable from not-found

At the API boundary, a cross-tenant identifier returns 404, byte-identical to a genuinely missing row, so tenants cannot be enumerated and existence cannot be probed. The database participates: the guarded transition function looks up the event pre-filtered by the caller's tenant claim and raises the same `WC404` error code for "not yours" and "does not exist". The API maps `WC401`/`WC403`/`WC404`/`WC409` to 401/403/404/409 without ever knowing which kind of 404 it is serving. That ignorance is the feature.
