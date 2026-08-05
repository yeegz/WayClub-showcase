# Tenancy: the account is the boundary, and the database enforces it

WayClub holds student data for many organisations in one database. Cross-tenant information disclosure is the critical risk in its threat model, so tenancy is enforced at the layer a forgotten application check cannot reach: the database itself.

The design position, recorded as ADR-0002 in the build repository, is blunt: application-level `WHERE tenant_id = ?` filtering alone fails open, because one forgotten predicate is a breach. With row-level security as the floor, a forgotten application check degrades to an empty result or a 404, never a leak.

This document describes the mechanism as it exists in the private repository: migrations in `infra/postgres/migrations/`, particularly `008_rls_and_grants.sql` and `017` through `019`, with tests in `infra/postgres/tests/wayclub-db.test.mjs`.

## The tenant root moved, and that is the most important thing here

Until migration 017 the tenant root was `institution_id`, and a university was a precondition for using WayClub at all. That contradicted the product: a club must be able to adopt WayClub without its university being a customer. Migrations 017 to 019 moved the boundary to the **account**.

Two columns now sit on every tenant-scoped table, and they are not redundant:

| Column | Meaning | Nullable |
|---|---|---|
| `account_id` | **Who owns the data.** The tenant boundary. Every policy keys off it. | Never null |
| `institution_id` | **Who governs the data.** Official reviewer authority, institution policy, verification badges, retention overrides. | Null for a standalone club, because no university governs it |

`account.account_type` is either `STANDALONE_CLUB` or `INSTITUTION`. A standalone account is one club that adopted WayClub on its own; an institution account is a university that may govern many clubs.

`account_id` was added to every table carrying `institution_id` by a **catalogue-driven loop** over `pg_class` in migration 017, not by a hand-written list, and the loop raises if it finds fewer than forty tables. A hand-written list is a security defect waiting to happen: one forgotten table is one table whose tenant boundary silently stays the old shape. Structural changes that must cover the whole schema are done this way throughout, so a forgotten table is impossible by construction rather than by review.

## Three database roles, one of which handles requests

| Role | Powers | Used by |
|---|---|---|
| `wayclub_admin` | LOGIN; owns every object | Migrations and seeds only |
| `wayclub_app` | LOGIN; owns nothing, no BYPASSRLS | Every normal API request; RLS binds it unconditionally |
| `wayclub_service` | LOGIN with BYPASSRLS | One narrowly-scoped audited job (the deadline sweep); never request handling |

Because `wayclub_app` is not a table owner and holds no bypass attribute, there is no code path in request handling where row-level security is off. "No service role in request paths" is enforced by connection string rather than by discipline: the service pool is deliberately never injected into a request path.

Its grants are enumerated per table, verb by verb, and the verbs differ on purpose. Most tenant tables get `select, insert, update`. Approvals, approval comments and published workflow definition versions get `select, insert` and no update at all, because those surfaces are append-only by design. Only registrations and waitlist entries get delete.

The separation deliberately mirrors hosted Supabase's own posture (`postgres` / `authenticated` / `service_role`), which keeps a later hosted migration clean.

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

The third argument makes the setting transaction-local. That single boolean carries a lot of weight: with pooled connections, a connection-local setting would leak one user's identity into the next request. Transaction-local scoping means identity and the work it authorises commit or vanish together. Because the whole request is one transaction, a multi-statement operation such as an authority transfer either lands entirely or not at all.

Since the shim matches the hosted contract (`auth.users`, `auth.uid()`, `auth.jwt()`, the `request.jwt.claims` GUC), adopting hosted Supabase later is a connection-string swap, not a policy rewrite.

## Deny by default, in two layers

Row-level security is enabled on every tenant-scoped table **in the same migration that creates the table**. Policies are written only for the tables the product actually reaches. The interesting part is what happens to the rest.

Read from the catalogue on 2026-08-05:

| Fact | Value |
|---|---|
| Tables in `public` | 93 |
| RLS enabled | 90 |
| Policies | 177, across 64 tables |
| Tables with policy coverage that is still incomplete in a load-bearing way | `club_invite` is account-scoped and is still missing RLS, which the fresh suite correctly fails on |
| Tables with RLS enabled, **no policies and no grants** | 26 |

Those twenty-six are the honest breadth gap: budgets and reimbursements, meetings and minutes, projects, venue and asset booking, club registration, general requests, notification preferences, event templates, calendar items, imports, retention, verified student identity, and the QR check-in token. They exist because the domain model is honest about where the product is going. They get:

- RLS enabled with **no policies**: in Postgres, RLS with no policy denies everything.
- **No grants** to `wayclub_app` at all.

So access to an unbuilt table fails twice: first at the grant layer (`42501 insufficient_privilege`), then, even if a grant were mistakenly added, at the policy layer. A future migration must add explicit policies and grants in the same change before any of these becomes reachable. **The safe state is the default state.**

For tables that do have policies, the shape is consistent: every policy tests tenancy **and** a relationship, and write policies are separate from and stricter than read policies.

```sql
create policy event_select on public.event
  for select to wayclub_app
  using (
    account_id = app.current_account_id()          -- tenancy
    and (                                           -- and a real relationship
      app.is_committee_of(club_id)
      or app.is_member_of(club_id)
      or created_by = auth.uid()
      or app.is_reviewer_for_club(club_id)
      or app.is_university_admin()                  -- governance; dead weight in a standalone account
      or (status in ('approved','scheduled','registration_open','live','completed')
          and deleted_at is null)
    )
  );
```

Three patterns worth noting:

- **`USING` and `WITH CHECK` do different jobs.** The committee's event update policy uses `USING` to admit only editable states and `WITH CHECK` to pin the resulting row inside that same set, so no direct update can move an event through its lifecycle. Lifecycle changes have exactly one path, a guarded `SECURITY DEFINER` function.
- **Relationship predicates live in `SECURITY DEFINER` helpers** (`app.is_member_of`, `app.is_committee_of`, `app.holds_stage_role`) owned by the schema owner with `search_path` pinned to `''`. A policy on one table can consult others through them without recursively triggering their RLS. Each helper validates its own caller's claims, which is the correct hardening, and they are locked down with `REVOKE ... FROM public` plus explicit `EXECUTE` grants.
- **Separation of duties is encoded in the same layer.** A club president can insert role assignments only for club-scoped committee roles in their own club; granting reviewer or institution roles requires a university administrator. A president cannot promote themself into their own approval chain, and the policy, not a code review convention, says so.

## A club cannot impersonate an institution, structurally

This is the strongest control in the system and it is worth stating on its own, because it is the one that does not depend on any policy being written correctly.

Every tenant-scoped table carries a composite foreign key:

```sql
foreign key (account_id, institution_id) references public.institution (account_id, id)
```

`public.institution` carries the matching `unique (account_id, id)`. A row may therefore only name an institution that its **own account** owns. A `STANDALONE_CLUB` account owns no institution row, so it cannot write a non-null `institution_id` anywhere, in any table, at all.

This is a **constraint, not a policy**. It binds the table owner and the BYPASSRLS service role exactly as it binds the request role. Every other control in this document could be misconfigured and this one would still hold. Verified in the suite: even the owning role gets SQLSTATE `23503` when it tries to point the seeded standalone club at another account's institution.

MATCH SIMPLE semantics are load-bearing here. A composite foreign key with any NULL column is not checked, so a null `institution_id` is always allowed and a non-null one is always verified against the row's own account. That is exactly the rule the product needs.

Three further structural controls stack on top, all trigger- or constraint-based so they bind the owner too:

- **Official reviewer roles are ungrantable in a standalone account.** A trigger refuses any role assignment naming an institution-scoped reviewer role inside a `STANDALONE_CLUB` account, and refuses a club-scoped assignment naming a club in another account.
- **`approval.authority` records whose authority a decision carried**: `CLUB_INTERNAL`, `ADVISOR_REVIEW`, `EXTERNAL_EVIDENCE` or `INSTITUTION_OFFICIAL`. A check constraint makes `INSTITUTION_OFFICIAL` impossible without an `institution_id`, and an RLS insert policy refuses it in a standalone account as well. The column default is **computed per caller**, so a decision written by an un-updated client lands with the honest value rather than the flattering one.
- **The trust ladder cannot be climbed from below.** A club's verification status moves from independent, to advisor-confirmed, to institution-verified, to institution-managed. A trigger requires an institution administrator acting as themselves for either institution rung, requires a genuinely active advisor for the advisor rung, and requires an institution administrator to *lower* an institution rung too, so a club cannot shed governance it dislikes.

An approval a club obtained outside WayClub is recorded in a separate evidence table, deliberately not in `public.approval`. An approval row is a decision a WayClub reviewer made inside the product; an evidence row is a scan of something that happened elsewhere. Conflating them would let a screenshot become an audit trail.

## Row-level security is enabled, and deliberately not forced

An earlier version of the build repository's security document claimed RLS was enabled "and forced". It was not, and the correction is more interesting than the claim.

`FORCE ROW LEVEL SECURITY` changes exactly one thing: whether policies also apply to the table **owner**. The owner here runs migrations and the seed, and it owns the `SECURITY DEFINER` helper functions that the policies themselves call. Those helpers are definer-owned precisely so that policy evaluation does not recurse into RLS.

Forcing RLS therefore breaks the mechanism it is meant to strengthen. Measured on the real database: with force enabled on the membership table, `app.is_member_of()` returned false for a genuine member and the owner's own `select count(*)` returned zero. That would take down every policy that consults membership, plus the seed.

The real boundary is elsewhere, and it holds: `wayclub_app` is the only role that serves requests, it owns nothing, and it has no BYPASSRLS, so RLS binds it fully. The definer helpers are the audited exceptions, and the correct hardening was not force but making each helper validate its own caller, which is what happened after an adversarial review proved that the audit writer accepted a cross-tenant forged row and that waitlist promotion authorised on tenancy alone. The decision is ADR-0008, so it cannot be reversed by somebody who has not read the reason.

**Named gap, stated rather than glossed:** the "owns nothing, holds no bypass" half of that posture is asserted in prose in three places and read from `pg_roles` in none. A stray `ALTER ROLE wayclub_app BYPASSRLS` would pass the whole suite. That is the one load-bearing property the catalogue tests do not yet pin.

## Coverage read from the catalogue, not from a list

Per-table tests rot: somebody adds a table and forgets the test. The suite instead discovers its own surface. Five tests read `pg_class`, `pg_policy` and `has_table_privilege` directly:

1. **Every tenant-scoped table has `relrowsecurity`.** The tenant-scoped set is defined as the two tenant-root tables plus every table carrying an `institution_id` **or** an `account_id` column. Keying that definition on `institution_id` alone would have quietly excluded entitlements, affiliation, claims, migrations and the whole continuity domain, none of which carry one.
2. **Force is deliberately off**, with the measurement above recorded in a comment.
3. **No tenant-scoped table is granted to `wayclub_app` without a policy**, with a positive control asserting the breadth tables really are ungranted and unpoliced.
4. **The audit log has RLS enabled, no insert, update or delete policy, and only a select policy**, read from `pg_policy.polcmd`.
5. **Every policy in the schema is keyed on the account**, not on the institution. Prose in a migration header is not evidence; `pg_policy` is.

Around those, the isolation sweep discovers every account-scoped table from the information schema and attempts a cross-tenant select and a cross-tenant write against each, in both directions, accepting only zero rows or `42501`. It carries positive controls, so a broken policy that denies everything cannot masquerade as passing isolation, and it includes write smuggling, where a row claiming the other tenant's account is refused by `WITH CHECK`.

The seed ships **four accounts** for exactly this purpose: two institutions, "Sunway Pilot (unofficial demo)" and the fully fictional "Meridian University", and two standalone clubs, Aurora Film Society and North London Film Collective. The third one proves the tenant boundary is the account rather than the institution, and that a club with no institution cannot acquire one. The fourth is GBP and Europe/London, and exists specifically so that no Malaysian default can hide in code and pass tests.

## 404, indistinguishable from not-found

At the API boundary, a cross-tenant identifier returns 404, byte-identical to a genuinely missing row, so tenants cannot be enumerated and existence cannot be probed. The database participates: the guarded transition function looks up the event pre-filtered by the caller's tenant and raises the same typed error for "not yours" and "does not exist". The API maps typed SQLSTATE codes onto HTTP status codes without ever knowing which kind of 404 it is serving. That ignorance is the feature.

What makes this a real property rather than an incidental one is where the test sits. In `apps/api/test/05-misc.spec.ts`, the assertion that a cross-tenant club is an indistinguishable 404 sits directly beside the assertion that a **same-tenant** outsider gets 403 with a `permission_denied` code. Both codes are pinned in adjacent tests, so a refactor that collapsed them would fail loudly.

## Entitlements are never authorisation

A separate table answers "is this module switched on for this account". It never answers "may this person do this". It is readable but not writable by the request role, and a test asserts mechanically against `pg_policy` that **no policy expression anywhere references the entitlement helper**. A paid plan never grants governance permissions, and that is checked by the catalogue rather than promised in a document.
