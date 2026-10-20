# Tenancy: the account is the boundary, and Postgres enforces it

WayClub keeps many teams, clubs and communities in one database. The failure that matters most is one group reading another group's members, meetings or events, so the tenant boundary is enforced by PostgreSQL itself rather than by application code that has to remember a `where` clause. The position is recorded as ADR-0002 in the build repository: filtering in the application alone fails open, because one forgotten predicate is a breach. With row-level security as the floor, a forgotten check degrades to an empty result or a 404.

Everything below is read from the private build repository: migrations in `infra/postgres/migrations/`, database tests in `infra/postgres/tests/`, the API in `apps/api/src/`. Catalogue figures were measured on 20 October 2026 on a database with all 57 migrations applied.

## Two kinds of workspace, one boundary

Every group lives in an **account**, and `account.account_type` is one of two values. `STANDALONE_CLUB` is an independent workspace: a society, a sports team, a hobby club or a community that started WayClub on its own. `INSTITUTION` is the optional context where a university or similar body governs many clubs and runs formal approvals. An independent group never needs the second kind to run.

Two columns sit on tenant data and they mean different things. `account_id` is **who owns the row**: it is the tenant boundary, it is never null, and every request policy keys off it. `institution_id` is **who governs the row**: official reviewer authority and institution policy. It is null for an independent group, because nobody governs it. Since migration 039 one person can belong to several workspaces through `account_membership`, and switching between them changes which account the session names.

## Three database roles, one of which serves requests

- `wayclub_admin` owns every object, runs migrations and the seed, and never serves a request.
- `wayclub_app` is the only role used to handle requests. It owns nothing and has no `BYPASSRLS`, so row-level security binds every query it runs.
- `wayclub_service` runs scheduled jobs such as the approval deadline sweep and is never injected into a request path.

The service role is narrower than it first was. Locally it is created with `BYPASSRLS` for convenience, but the managed bootstrap (`infra/deploy/google/bootstrap.sql`) creates all three roles `nobypassrls`, and migrations 046 and 047 give the job role 13 policies of its own: read the stages, events and roles it sweeps, work the email outbox, insert only SLA notifications, and insert audit rows only with no human actor and one of two SLA actions. `apps/api/test/97-service-role-portability.spec.ts` runs the real sweep as a role with no bypass and asserts it cannot read password hashes, edit an event or delete a notification.

## Identity travels in a transaction setting

Each request runs as one transaction on a `wayclub_app` connection (`apps/api/src/db/request-db.ts`). As soon as the session is verified, the API runs `set_config('request.jwt.claims', $claims, true)`. The third argument makes the setting transaction-local, so a pooled connection cannot carry one person's identity into the next request, and identity commits or vanishes with the work it authorised.

The policies read that setting through `wayclub_auth.uid()` and `wayclub_auth.jwt()`. They have the same contract as Supabase's `auth.uid()` and `auth.jwt()`, but they live in a schema WayClub owns: ADR-0013 records how the original `auth` schema collided with hosted Supabase, which already owns a schema of that name. The tenant itself comes from one function, `infra/postgres/migrations/022_account_claims_and_standalone_onboarding.sql`:

```sql
create or replace function app.current_account_id() returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(wayclub_auth.jwt() ->> 'account_id', '')::uuid
$$;
```

It reads the account claim and nothing else. A claim set that does not name an account resolves to null, every account-keyed predicate is then null rather than true, and the request reads nothing. The claims themselves are never copied from the token: `apps/api/src/auth/auth.guard.ts` resolves the person's account, account type and institution from the database, refuses a token whose values differ, and refuses a token whose session generation is older than the person's last sign-out.

## Every policy names the account and a relationship

A policy tests tenancy and then a real relationship to the row. The committee workspace in migration 051 is typical: a meeting is visible when `account_id = app.current_account_id()` and the caller is on that club's committee, and nobody else, including institution oversight, can read it.

Relationship checks such as `app.is_member_of` and `app.is_committee_of` are `SECURITY DEFINER` helpers, so a policy on one table can consult another without recursing into its row-level security. Of the 137 functions in the `app` schema, 128 are `SECURITY DEFINER`, and every one of them pins its `search_path`: 126 to the empty string and two rate-limit helpers to `pg_catalog, wayclub_auth`. Each is revoked from `public` and granted explicitly.

## Deny by default, measured

Of the 96 tables in `public`, 94 have row-level security enabled. The two without are the `role` lookup table and the `schema_migrations` ledger, neither of which holds tenant data. There are 218 policies across 70 tables: 205 apply to the request role and 13 to the job role.

24 tables have row-level security enabled, no policies and no grant to `wayclub_app`. Most are domain shape that is not yet a product: budgets, reimbursements, purchase requests, venue and asset booking, feature flags. In Postgres, row-level security with no policy denies everything, and the missing grant refuses earlier still with `42501`, so an unbuilt table fails twice before anything leaks. Club invitations are in the same state deliberately: they are reachable only through `SECURITY DEFINER` functions that check the caller.

## A club cannot pose as an institution

The strongest control is a constraint, not a policy. 77 tables carry a composite foreign key from `(account_id, institution_id)` to `institution (account_id, id)`, so a row may only name an institution its own account owns. An independent workspace owns no institution row and therefore cannot write a non-null `institution_id` anywhere. Constraints bind the owner and the job role as well, and the suite proves it: even `wayclub_admin` gets `23503` when it points an independent club at another account's institution.

Two more rules stack on top. A trigger refuses official reviewer roles inside an independent workspace. And `approval.authority` records whose authority a decision carried (`CLUB_INTERNAL`, `ADVISOR_REVIEW`, `EXTERNAL_EVIDENCE` or `INSTITUTION_OFFICIAL`), with a check constraint that makes `INSTITUTION_OFFICIAL` impossible without an institution. A letter a club obtained outside WayClub is filed as evidence in its own table, never as an approval.

## Enabled, deliberately not forced

`FORCE ROW LEVEL SECURITY` only changes whether policies bind the table owner. The owner here runs migrations and owns the definer helpers that the policies call, and forcing it was measured to break them: `app.is_member_of()` returned false for a genuine member. ADR-0008 records the decision. The boundary is that `wayclub_app` owns nothing and cannot bypass, and the definer helpers each validate their own caller.

## Tests that read the catalogue instead of a list

A per-table test rots the day somebody adds a table and forgets it. The `RLS coverage (mechanical)` block in `infra/postgres/tests/wayclub-db.test.mjs` discovers its own surface from `pg_class` and `pg_policy`. It asserts that every table carrying an `account_id` or `institution_id` has row-level security, that force is off, that no such table is granted to the request role without a policy, and that the request role has only a select policy on the audit log.

Its last assertion is the one that keeps the boundary honest as the schema grows: **every request-role policy must mention `app.current_account_id()`**, and the only policies allowed to compare the institution claim are the two on the institution row itself. When five restrictive policies added for the committee workspace and the publishing policy did not name the account, they were found and fixed in review on 18 October; this assertion is what fails the suite if that shape returns.

Beside it, the account sweep finds every table with an `account_id` column and, as six people across three seeded accounts, attempts to read and to re-home rows from every other account. It accepts only zero rows or a refusal, and positive controls stop a policy that denies everything from passing as isolation.

What is still a gap: the local suite does not read `pg_roles` for `wayclub_app`. That check now lives in the release tooling (`infra/deploy/google/checks/database-checks.mjs`), which fails if the request role can bypass row-level security, is a member of a privileged group, or if any object is owned by anyone but `wayclub_admin`. It is written and unit-tested, and has not yet run against a launched database, because there is none.

## 404, indistinguishable from not found

A cross-tenant identifier returns 404, the same as a row that does not exist, so a caller cannot probe which ids are real. The database takes part: `app.transition_event` looks the event up inside the caller's account and raises the same `WC404` for "not yours" and "does not exist", and `apps/api/src/common/api-exception.filter.ts` maps it to 404 without knowing which case it is serving. In `apps/api/test/05-misc.spec.ts` the test that a club in another account is an indistinguishable 404 sits next to the test that a same-account outsider gets 403 `permission_denied`, so a change that blurred the two would fail.
