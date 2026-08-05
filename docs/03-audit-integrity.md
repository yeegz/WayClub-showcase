# An audit log that forked under load, until it did not

An approval platform's audit log is the artefact a university will eventually put in front of a committee, or an auditor, or a dispute. "We log everything" is not a property. "The log cannot be silently edited, here is what tampering would look like, and here is the concurrency bug we found in our own first design" is.

This document describes WayClub's audit design as built in the private repository: `infra/postgres/migrations/006_audit.sql`, the two integrity fixes in `011` and `012`, the re-keying in `019_account_rls.sql`, and the tests in `infra/postgres/tests/wayclub-db.test.mjs`. The reasoning is ADR-0009.

## The table, and what chains it

Every approval decision, lifecycle transition, role grant, gallery moderation and continuity transfer writes one row. Audit rows never contain secrets, password material or claims JSON. Reading the log is restricted by RLS to administrators of the row's **own account**, and in a standalone workspace to the club's own officers.

The chain is **per account**, not per institution, and that is not a cosmetic change. A chain keyed on the institution cannot cover a tenant that has no institution, and a standalone club is exactly that. Migration 019 moved the chain to the account and binds both identifiers into the hashed payload:

```text
hash = sha256(
     coalesce(prev_hash, '')
  || '|' || account_id
  || '|' || coalesce(institution_id, '')
  || '|' || coalesce(actor_id, '')
  || '|' || action
  || '|' || target_type
  || '|' || coalesce(target_id, '')
  || '|' || coalesce(detail::text, '')
  || '|' || to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
)
```

Because moving the chain changed the hash inputs, the migration **verifies the existing chain under the old formula first and refuses to run if it does not verify**, then re-derives every hash from the rows' own immutable contents in chain order. Re-hashing a chain that already verified preserves exactly what the chain proved; doing it to an unverified chain would launder a forgery. That is why the check is not optional.

The hashed byte format is pinned, including Postgres's exact UTC timestamp rendering, because chain verification is only meaningful if an independent verifier can reproduce the input byte for byte.

## Four layers against mutation

**1. Grants.** `wayclub_app`, the only role in request handling, holds `SELECT` only. No role is granted `UPDATE` or `DELETE`; even the BYPASSRLS service role has those verbs explicitly revoked.

**2. A trigger that blocks everyone, including the owner.** Grants do not bind a table's owner, so a grants-only design leaves an owner-shaped hole:

```sql
create trigger audit_event_block
  before update or delete on public.audit_event
  for each row execute function app.tg_audit_block();
```

The suite proves it from both directions: the request role fails at the grant layer with `42501`, and the **owner role itself** fails at the trigger. Rewriting history through any SQL path now requires first dropping the trigger, which is a loud schema change rather than a quiet data edit.

The block carries exactly one narrowly-scoped exemption: the chain trigger's own one-time write, which fills the position and the two hashes on a row that has none and changes nothing else. That exemption is unreachable once a row is committed, because a committed row always has a chain position, so from any later transaction the table is strictly append-only for every role.

**3. Writes cannot be forgotten.** Rows are written by `SECURITY DEFINER` trigger functions attached to the audited tables themselves, so a role grant, a stage decision, an approval, an event creation or a lifecycle transition writes its audit row whether or not the application remembers to. `wayclub_app` has no direct insert right on the table at all.

There are **three writers at three privilege levels**, which is the shape an adversarial review forced. The request-role entry point pins the account, the institution and the actor to the caller's own claims, so naming another tenant's institution or another user as actor is refused; that fix exists because the reviewer proved the original accepted a cross-tenant forged row. The unvalidated writer used by owner-definer trigger functions, which pass the audited row's own tenancy, is granted to **no role at all**. A legacy system writer now refuses rather than writing an untenanted row.

**4. The hash chain**, which is where the interesting failure was.

## The chain forked under concurrency, and a serial test suite could never have shown it

The first design assigned chain position from `seq bigint generated always as identity` and chained in a `BEFORE INSERT` trigger.

Postgres allocates an identity value **while forming the tuple**, which is *before* the `BEFORE INSERT` trigger runs and therefore before the trigger takes its advisory lock. Allocation order and lock order could differ. Because the lock was then held for the rest of the transaction, a second write by the lock holder took a higher `seq` while an already-waiting transaction held a lower one, and that waiting transaction then chained its lower-`seq` row onto the higher-`seq` row.

Reproduced, before the fix:

```text
CHAIN BREAK at seq=130 (T2_only):   hash_prev=cf8aa0fd5ce5 but previous row's hash=a856668fda7f
CHAIN BREAK at seq=131 (T1_second): hash_prev=a856668fda7f but previous row's hash=c6d9a29daf45
```

Three changes closed it:

- **`chain_index` is the authoritative position**, allocated *inside* the lock, so chain order and lock order are the same order by construction. `seq` survives as an insertion-order surrogate and as the audit API's pagination cursor. **Verification must walk `chain_index` ascending within one account, never `seq`.** The originally shipped verifier walked `seq`, so it would have failed on an honest database and only passed because the suite ran serially.
- **Chaining moved to a `DEFERRABLE INITIALLY DEFERRED` constraint trigger** that fires during COMMIT.
- **`unique (account_id, chain_index)` is the structural backstop.** If the serialisation were ever removed or defeated, two rows would collide and the transaction would fail loudly instead of forking the chain silently.

The covering test genuinely overlaps two transactions rather than asserting the property against a serial suite. That distinction is the whole lesson: the original test passed for a reason unrelated to the property it claimed to check.

## The same fix was an availability fix

The advisory lock used to be taken at the first audit write and held to commit, so one slow request serialised every audited write in its tenant. Measured before the fix, with one transaction holding for five seconds after its audit write: same-tenant audited writes took 4,780 ms and 4,792 ms, while another tenant's took 43 ms. The critical section is now the commit itself, which brought the same experiment down to roughly 50 milliseconds.

Worst case, if a session runs `SET CONSTRAINTS ALL IMMEDIATE`, the lock is held longer again, but the chain position is still allocated inside the lock: availability degrades, correctness does not.

## Verification by recomputation

The suite does not trust the chain; it recomputes it. Reading through the RLS-bound administrator path, which also exercises the select policy, it walks every audit row for the account in `chain_index` order and recomputes each hash in Node from the row's own columns, asserting both the hash and the `hash_prev` linkage.

A separate implementation, in a separate language, agreeing hash by hash with the trigger is the point: the chain's meaning does not depend on the code that wrote it.

## What tampering looks like

Suppose somebody with direct database access wants to change one historical row, say to alter who approved an off-campus trip.

- **Editing the row** changes the input to its hash, so recomputation fails from that row onward. Verification reports the exact chain position where history diverged.
- **Editing the row and recomputing its hash** breaks the next row's `hash_prev`, so the attacker must rewrite the entire suffix of that account's chain, consistently. The append-only trigger blocks that through every SQL path short of schema surgery.
- **Deleting a row** leaves a gap in the chain positions and a `hash_prev` naming a hash no longer present. Recomputation fails at the splice.
- **Inserting a fabricated old row** cannot be placed inside the chain: its neighbours' hashes do not commit to it, and the unique constraint on the account and position refuses a duplicate.

The honest boundary: hash chaining makes tampering **evident**, not impossible. An attacker with schema-owner access and no fear of detection could drop the trigger and rebuild the suffix. What the design guarantees is that such an attack cannot be quiet: it requires DDL, it touches every subsequent row for that account, and it diverges from every backup.

Two things that follow from that boundary are **planned rather than built**, and are not claimed here: scheduled chain-verification tooling for operators, and externally anchored checkpoints. No backup has ever been restored either, which is worth saying in the same breath, because a chain that diverges from a backup only helps somebody who has one.

## Why per-account chains

One global chain would interleave every tenant: verifying one organisation's history would require reading everyone's, and a single dispute would drag the whole platform's log into scope. Per-account chains keep verification tenant-local, matching the access model where an administrator can only read their own account's log; they keep the advisory lock from serialising unrelated tenants' writes; and they mean an exported audit trail is self-contained and independently checkable after export.
