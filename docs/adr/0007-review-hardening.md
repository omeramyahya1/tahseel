# 7. Hardening from the first code review

Date: 2026-11-21

## Status

Accepted. Amends ADR 0003 (TL004 mechanism) and ADR 0005 (idempotency takeover).

## Context

An automated review of `main` raised 16 findings. All 16 still held when checked against the code, and all are fixed on `fix/review-findings`. Most are local bug fixes, recorded in the commit messages. Four change a design described in an earlier ADR, or add a rule future code must follow, so they're recorded here.

## Decision

1. **TL004 uses the creating transaction's ID, not its timestamp** (amends ADR 0003).
   - `ledger_journals.created_xact_id` is stamped with `pg_current_xact_id()`. That's the top-level transaction ID, so it's the same inside savepoints.
   - A posting must come from that same transaction.
   - The old `created_at = now()` check let a different transaction with the same start microsecond append to a committed journal.

2. **Idempotency claims are owned by a `claim_token` and checked inside the business transaction** (amends ADR 0005).
   - **Before changing anything,** `idempotentTx()` locks its own claim row (`FOR UPDATE` on the token). If the claim was taken over, the request aborts with 409.
   - **Takeover** of a stale or expired claim deletes only the claim it inspected, and only if that row is still eligible, re-checked in SQL. If the owner is mid-transaction, the delete waits for its row lock. Once the owner commits, the retry finds a completed row and replays it.
   - **Elapsed time alone no longer lets two owners both commit.** ADR 0005 named this as a known gap; it's now closed.

3. **Secrets in stored responses are encrypted.**
   - `idempotentTx(…, { secretFields })` stores the listed response fields AES-256-GCM-encrypted (`{"$encrypted": …}`), and they're decrypted only on replay.
   - A retried `POST /v1/webhook_endpoints` still returns its `whsec_` secret, but it's never in plaintext at rest.
   - Rule: every response field carrying a secret must be listed.

4. **Job acknowledgements are tied to a claim generation.**
   - `complete`/`fail`/`release` only apply while the job is `running` with the claimed `attempts`. A worker whose lock expired can't overwrite the state of the worker that reclaimed the job.
   - `stop()` waits for an in-progress claim, and releases any jobs it claimed after shutdown began.

## Consequences

- Duplicate execution under slow requests is closed at the database level, not by timeouts.
- Migrations 0009–0011 add `idempotency_keys.claim_token`, partition TRUNCATE guards and `ledger_journals.created_xact_id`. Pre-existing journals have `NULL` there and can never gain postings, which is correct.
- Still open (unchanged):
  - Webhook DNS rebinding needs an egress proxy or IP pinning before production (ADR 0006).
  - An owner can still disable triggers, or drop/detach partitions, until separate DB roles exist.
