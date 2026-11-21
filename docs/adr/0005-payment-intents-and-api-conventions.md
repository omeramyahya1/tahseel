# 5. Payment intents and API conventions

Date: 2026-11-21

## Status

Accepted. Idempotency takeover amended by ADR 0007.

## Context

Merchants need one API to request a payment and learn reliably whether it was paid, on rails modelled on NIPS request-to-pay (ISO 20022 pain.013 / pacs.002). Rail access doesn't exist yet, so a simulated rail stands in for test mode. Decisions made with the product owner:
- The object is named `payment_intent`.
- There are test and live modes.
- The merchant confirms with the payer's alias.
- Default expiry is 15 minutes, settable from 1 minute to 7 days.
- Timestamps are ISO 8601.
- The accrued fee is exposed on the object.

## Decision

**State machine.** Enforced by DB triggers (`migrations/0006_payments_invariants.sql`) and mirrored in `modules/payments/status.ts`:

```
requires_confirmation ──confirm──► processing ──rail: succeeded──► succeeded
        ▲                              │
        └────────── rail: declined ────┤
requires_confirmation ──cancel──► canceled
requires_confirmation ──expires_at (our clock)──► expired
processing ──rail: expired──► expired
```

- `succeeded`, `canceled` and `expired` are terminal.
- A decline returns the intent to `requires_confirmation`, with `last_payment_error` set, so the merchant can retry with another alias.
- **A `processing` intent is never expired by our clock**, only when the rail says the request-to-pay expired. Otherwise we could expire an intent the payer actually paid. The rail is told `expires_at`, so it can refuse late approvals.

**Attempts.** Each confirm creates a `payment_attempt`: one request-to-pay, whose ID is the end-to-end ID. Rail reports are matched to the attempt and are idempotent: a report for a finished attempt is a no-op. A report that doesn't match the intent's current state throws, so the job goes dead for human review rather than guessing about real money.

**Async rail calls via the outbox.** Confirm commits the attempt together with a `request_to_pay` job on the rail's queue (`rail:<name>`). The worker calls the rail outside any transaction. Rail status reports, whether from a callback or the simulator, become `rail_status` jobs on the same queue.

**One transaction on success.** It covers:
- Intent → `succeeded`, with the fee computed from merchant pricing.
- Attempt → `succeeded`.
- Transition history row.
- Ledger journal: memo volume, plus the fee accrual when non-zero.
- `payment_intent.succeeded` event.

**Events.** `payment_intent.created`, `.processing`, `.succeeded`, `.payment_failed`, `.canceled` and `.expired`. `data.object` is the public representation at that moment.

**API conventions:**
- **IDs:** prefixed ULIDs: `pi_` (payment intent), `pa_` (attempt), `evt_` (event).
- **Amounts:** integers in piasters. JSON numbers are validated as safe integers and become `bigint` internally.
- **Currency:** `"SDG"`, required on create.
- **Timestamps:** ISO 8601 UTC strings.
- **Errors:** `{ error: { type, code, message, param? } }`, with Stripe's error types.
- **Lists:** `{ object: "list", data, has_more }`, newest first, paginated with `limit` (1–100) and `starting_after`.
- **`Idempotency-Key` is required on every POST.** Keys are scoped to merchant and mode and kept for 24 h.
  - Same key and same request (method, path, body hash) → replay of the stored response, with `Idempotent-Replayed: true`.
  - Different request → 422.
  - Original still in flight → 409.
  - A 5xx response releases the key.
  - State-changing handlers store their response **in the same transaction** as the change. A crash therefore can't leave a committed change without its stored response, so an `in_progress` key older than 60 s can safely be taken over.
- **Payer alias:** Sudanese mobile number in E.164 (`+249` + 9 digits). Other NIPS alias types (email, handle) can be added later.
- **Test mode:** the simulated rail picks the outcome from the alias:
  - `+249900000001` succeeds
  - `+249900000002` declines
  - `+249900000003` never responds
  - `+249900000004` is an unknown alias
- **Live mode:** confirm returns `503 rail_unavailable` until a real rail connector exists.
- **OpenAPI 3.1:** generated from the route definitions and served publicly at `/v1/openapi.json`.

## Consequences

- Merchants can rely on webhooks and the API, never on payer-supplied proof.
- An intent stuck in `processing` (a rail that never reports) needs a status-polling job per real rail, and ops visibility. That isn't built yet.
- A request that runs longer than 60 s with the same idempotency key could be taken over and run twice. Handlers are short; a statement timeout would make this airtight.
- Reconciliation against rail statements (`reconciled_at`) is still to come.
