# An audit log that forked under load, and how it stopped

When a committee is asked who approved a trip, who granted someone a role or when the minutes were signed off, "we log everything" is not an answer. The useful properties are narrower: the log cannot be quietly edited, tampering would be visible, and the design has survived its own concurrency bug. This document describes WayClub's audit log as built in the private repository: `infra/postgres/migrations/006_audit.sql`, the fixes in `011` and `012`, the per-account re-keying in `019_account_rls.sql`, the job-role policy in `046`, and the tests in `infra/postgres/tests/wayclub-db.test.mjs`. The reasoning is ADR-0009.

## What is written, and who can read it

One row is written for each decision, permission change and state transition: role grants, approval stage decisions, approvals, event creation and every event status change, approval of meeting minutes, changes to a club's trust and tenancy, and the deadline sweep's escalations. Rows never contain secrets, password material or session claims.

Reading is narrow on purpose. The only request-role policy on `audit_event` admits rows from the caller's own account, and only to an institution administrator or, in an independent workspace, to the group's own officers. Ordinary members read nothing. Because the log is readable by those people, some things are deliberately never audited: saving an event is private to the person who saved it (migration 034), and auditing it would hand an administrator the very record the save policy refuses them.

## Four layers against changing history

**Grants.** `wayclub_app` holds `SELECT` only and cannot insert directly. The job role may insert, and a policy from migration 046 limits it to rows with no human actor, one of two SLA actions and a workflow stage as the target. No request or job role holds `UPDATE` or `DELETE`.

**A trigger that blocks the owner too.** Grants do not bind a table's owner, so `audit_event_block` refuses every `UPDATE` and `DELETE` from every role, `wayclub_admin` included, with error `WC403`. It has one narrow exemption: the chain trigger's own one-time write, which fills the position and the two hashes on a row that has none and changes nothing else. A committed row always has a position, so the exemption cannot be reached after commit.

**Writes that cannot be forgotten.** Rows are written by `SECURITY DEFINER` triggers on the audited tables, so a role grant or a stage decision is audited whether or not the application remembers. There are three writers. `app.write_audit`, the request-role entry point, pins the account, the institution and the actor to the caller's own claims; that fix exists because an adversarial review proved the original accepted a forged row naming another tenant. `app.write_audit_scoped`, which the triggers use, is executable by no login role. A legacy system writer now refuses rather than write a row with no tenant.

**The hash chain**, which is where the interesting failure was.

## The chain, per account

Each account has its own chain. Migration 019 moved it from the institution to the account, because a chain keyed on an institution cannot cover an independent group that has none. The chain trigger in `019_account_rls.sql` takes a per-account lock, then hashes the previous row's hash together with the row's own immutable columns:

```sql
  perform pg_advisory_xact_lock(hashtext('audit:' || new.account_id::text)::bigint);
  ...
      hash        = encode(public.digest(convert_to(
          coalesce(v_prev_hash, '')
          || '|' || a.account_id::text
          || '|' || coalesce(a.institution_id::text, '')
          || '|' || coalesce(a.actor_id::text, '')
          || '|' || a.action
          || '|' || a.target_type
          || '|' || coalesce(a.target_id::text, '')
          || '|' || coalesce(a.detail::text, '')
          || '|' || to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        'UTF8'), 'sha256'), 'hex')
```

The timestamp format is pinned to the microsecond so an independent verifier can rebuild the input byte for byte. Re-keying changed the hash inputs, so migration 019 first walks every existing chain under the old formula and refuses to run if any row fails. Re-hashing a chain that verified preserves what it proved; re-hashing one that did not would launder a forgery.

## How it forked

The first design took the chain position from `seq`, an identity column, and chained in a `BEFORE INSERT` trigger. Postgres allocates an identity value while it forms the row, before the trigger runs and so before the trigger took its lock. Allocation order and lock order could differ. A transaction already holding the lock could write a second row with a higher `seq` while another transaction waited with a lower one, and the waiting row then chained onto the higher one. Reproduced before the fix, verification reported two chain breaks, at `seq` 130 and 131.

The verifier that shipped with it walked `seq` order. It would have failed on any honestly concurrent database and passed only because the test suite ran serially: the test asserted the property while the property was broken.

Migration 011 closed it in three moves:

- `chain_index` became the authoritative position, allocated inside the lock, so chain order and lock order are the same order by construction. `seq` survives as insertion order and the audit API's page cursor. Verification walks `chain_index` within one account and never `seq`.
- Chaining moved to a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that fires during commit.
- `unique (account_id, chain_index)` is the backstop. If the serialisation were ever removed, two rows would collide and the transaction would fail loudly instead of forking quietly.

The same fix restored availability. The old lock was taken at the first audit write and held to commit, so one slow request stalled every audited write in its tenant. With one transaction holding for five seconds after its audit write, same-tenant writes took 4,780 ms and 4,792 ms while another tenant's took 43 ms; after the fix the same experiment came down to about 50 ms (both figures from ADR-0009). If a session forces constraints to run immediately, the lock is held longer again, but the position is still allocated inside it: availability degrades, correctness does not.

## How the suite checks it

The concurrency test opens two real connections with genuinely overlapping transactions, commits both, and asserts that the row written last holds a lower `seq` than the row before it in the chain, which is exactly the inversion that used to fork it. It then verifies the chains of three seeded tenants.

Verification is recomputation, not trust. The suite reads every row of an account through the request role, as a person the read policy admits, in `chain_index` order and recomputes each hash in Node from the row's own columns. A second implementation in a second language agreeing hash by hash is the point: the chain means something without the code that wrote it. Another test asserts that every committed row is chained and that each of the four seeded accounts has positions running from 1 to its row count with no gaps, so a missing link is arithmetic rather than opinion.

The same recomputation now exists for operators: the read-only restore check in `infra/deploy/google/checks/database-checks.mjs` recomputes every account's chain from a restored database. It is written and unit-tested, and no restore drill has run it yet.

## What tampering looks like

- Editing a row changes its hash input, so recomputation fails at that row.
- Editing a row and its hash breaks the next row's link, so the whole suffix of that account's chain must be rewritten, and the blocking trigger refuses that from every role.
- Deleting a row leaves a gap in the positions and a link to a hash that no longer exists.
- A fabricated old row cannot be placed inside the chain: its neighbours do not commit to it, and the unique position refuses a duplicate.

The honest boundary is that hash chaining makes tampering evident, not impossible. The schema owner can still drop the trigger or truncate the table, and could then rebuild a suffix. What the design guarantees is that such an attack is not quiet: it needs schema-level access, touches every later row for that account, and disagrees with every backup. Externally anchored checkpoints are not built, and no backup has yet been restored in a recorded drill, which matters because a chain that disagrees with a backup only helps someone who has one.

## Why one chain per account

One global chain would interleave every group: checking one club's history would mean reading everyone's, and one dispute would pull the whole platform's log into scope. Per-account chains keep verification inside the group, match the rule that people can only read their own account's log, stop one group's writes from waiting on another's lock, and let an exported trail be checked on its own.
