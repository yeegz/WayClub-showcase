# An append-only audit log with per-tenant hash chaining

An approval platform's audit log is the artefact a university will eventually put in front of a committee, or an auditor, or a dispute. "We log everything" is not a property; "the log cannot be silently edited, and here is what tampering would look like" is. This document describes WayClub's audit design as built in the private repository: `infra/postgres/migrations/006_audit.sql`, verified in `infra/postgres/tests/wayclub-db.test.mjs`, threat model in `docs/SECURITY.md`.

## The table

```sql
create table public.audit_event (
  seq            bigint generated always as identity,
  id             uuid primary key default gen_random_uuid(),
  institution_id uuid not null references public.institution(id),
  actor_id       uuid,                    -- null = system/seed action
  action         text not null,
  target_type    text not null,
  target_id      uuid,
  detail         jsonb not null default '{}'::jsonb,
  hash_prev      text,
  hash           text not null,
  created_at     timestamptz not null default now()
);
```

Every approval decision, lifecycle transition, role grant and permission change writes one row. Audit rows never contain secrets, password material or claims JSON. Reading the log is restricted by RLS to university administrators, scoped to their own tenant.

## Defence in depth: four layers against mutation

**1. Grants.** `wayclub_app`, the only role in request handling, holds `SELECT` only. No role in the system is granted `UPDATE` or `DELETE` on `audit_event`; even the BYPASSRLS service role has those verbs explicitly revoked.

**2. A trigger that blocks everyone, including the owner.** Grants do not bind a table's owner, so a grants-only design leaves a superuser-shaped hole. WayClub adds:

```sql
create function app.tg_audit_block() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_event is append-only (% blocked)', tg_op using errcode = 'WC403';
end;
$$;

create trigger audit_event_block
  before update or delete on public.audit_event
  for each row execute function app.tg_audit_block();
```

The test suite proves this from both directions: the app role fails at the grant layer (`42501`), and the **owner role itself** fails at the trigger (`WC403`). Rewriting history through any SQL path now requires first dropping the trigger, which is a loud, visible schema change rather than a quiet data edit.

**3. Writes cannot be forgotten.** Rows are written by `SECURITY DEFINER` trigger functions attached to the audited tables themselves (`role_assignment`, `workflow_stage`, `approval`, `event`), so a role grant, a stage decision, an approval record, an event creation or a lifecycle transition writes its audit row whether or not the application remembers to. API-initiated actions use `app.write_audit(...)`, also `SECURITY DEFINER`; `wayclub_app` has no direct INSERT right on the table at all.

**4. The hash chain.** Each row's `hash` commits to the previous row's hash for the same institution, forming a per-tenant chain.

## How the chain is computed

A `BEFORE INSERT` trigger computes:

```text
hash = sha256(
  coalesce(prev_hash, '') || '|' || institution_id || '|'
  || coalesce(actor_id, '') || '|' || action || '|'
  || target_type || '|' || coalesce(target_id, '') || '|'
  || coalesce(detail::text, '') || '|'
  || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
)
```

hex-encoded, with `hash_prev` set to the previous row's hash. Two details matter more than they look:

- **A per-institution advisory transaction lock** (`pg_advisory_xact_lock` over a hash of the institution id) serialises chain writes. Without it, two concurrent transactions could both read the same "latest" hash and fork the chain; with it, the chain is linear by construction, while different tenants' chains never contend with each other.
- **The hashed byte format is pinned**, including Postgres's exact UTC timestamp rendering. Chain verification is only meaningful if an independent verifier can reproduce the input byte-for-byte.

## Verification by recomputation

The test suite does not trust the chain; it recomputes it. Reading through the RLS-bound admin path (which also exercises the SELECT policy), it walks every audit row for the tenant in `seq` order and, in Node:

```js
const recomputed = createHash("sha256")
  .update(`${prev ?? ""}|${row.inst}|${row.actor}|${row.action}|${row.target_type}|${row.target}|${row.detail}|${row.ts}`, "utf8")
  .digest("hex");
expect(recomputed).toBe(row.hash);
expect(row.hash_prev).toBe(prev);
```

A separate implementation, in a separate language, agreeing hash-by-hash with the trigger is the point: the chain's meaning does not depend on the code that wrote it.

## What tampering looks like

Suppose someone with direct database access wants to change one historical row, say, to alter which account approved an off-campus trip.

- **Editing the row** changes the input to its hash, so the stored `hash` no longer matches recomputation. Every subsequent row's `hash_prev` linkage still matches, but recomputation fails from the edited row onward. Verification reports the exact `seq` where history diverged.
- **Editing the row and recomputing its hash** breaks the next row's `hash_prev`, so the attacker must rewrite the entire suffix of the chain: every later hash, for that tenant, consistently. The append-only trigger blocks that through every SQL path short of schema surgery, and backups plus any externally held checkpoint make a rewritten suffix evident.
- **Deleting a row** leaves a `seq` gap and a `hash_prev` that names a hash no longer present. Recomputation fails at the splice.
- **Inserting a fabricated old row** cannot be placed inside the chain: its neighbours' hashes do not commit to it, and `seq` is generated always as identity.

The honest boundary: hash chaining makes tampering **evident**, not impossible. An attacker with schema-owner access and no fear of detection could drop the trigger and rebuild the suffix. What the design guarantees is that such an attack cannot be quiet: it requires DDL, touches every subsequent row, and diverges from every backup and checkpoint. For the pilot, chains are recorded from the first row; scheduled chain-verification tooling and externally anchored checkpoints are explicitly planned for the institution-ready phase and are not claimed as built.

## Why per-tenant chains

One global chain would interleave all tenants: verifying one institution's history would require reading everyone's, and a single tenant's dispute would drag the whole platform's log into scope. Per-institution chains keep verification tenant-local (matching the RLS access model, where an admin can only read their own tenant's log), keep the advisory lock from serialising unrelated tenants' writes, and mean a tenant's exported audit trail is self-contained and independently checkable after export.
