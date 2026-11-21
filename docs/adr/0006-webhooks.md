# 6. Webhooks

Date: 2026-11-21

## Status

Accepted

## Context

Merchants must learn about payment outcomes without polling, and must be able to trust what they receive, because the whole product replaces "screenshot as proof". Deliveries go to arbitrary merchant URLs from servers that also hold payment data. Test mode runs on the same production servers, so a webhook URL is an SSRF vector in both modes. Decided with the product owner:
- Private networks are blocked, except with a development-only flag.
- HTTPS is required in live mode.
- Deliveries retry for about 3 days, then give up. No auto-disabling yet.

## Decision

**Fan-out through the outbox.** Every `EventBus.publish` enqueues `dispatch_event` in the same transaction as the business change. The dispatcher inserts one `webhook_deliveries` row per subscribed endpoint, unique per (event, endpoint), plus a `deliver_webhook` job. Both are idempotent, so at-least-once job execution never duplicates a delivery.

**Delivery.** A `POST` of the public event object (`evt_…`, `type`, `livemode`, `created_at`, `data.object`):
- Headers: `Content-Type: application/json`, `User-Agent: Tahseel-Webhooks/1.0`, and
  `Tahseel-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
- Receivers should verify the signature over the raw body and reject timestamps older than 5 minutes. `verifyWebhookSignature()` is the reference implementation, and will go into the SDK.
- 10 s timeout. Only 2xx counts as success. Redirects are never followed and count as failures.
- Retries after 1 m, 5 m, 15 m, 30 m, 1 h, 2 h, 4 h, 8 h, then 12 h four times: 13 attempts over about 2.7 days. After that the delivery is `failed`. The endpoint stays enabled.
- Every attempt is recorded in append-only `webhook_delivery_attempts`: status, duration, error, and a 1 KB response excerpt.

**Secrets.** Each endpoint has its own `whsec_…` secret, returned once at creation. It's stored encrypted (AES-256-GCM via `KeyProvider`), because Tahseel must be able to sign with it.

**URL policy (SSRF).** Checked at creation and again before every delivery, because DNS can change:
- `http`/`https` only, with `https` required in live mode, and no embedded credentials.
- Reject loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved addresses, whether given as IP literals or reached after DNS resolution. `localhost` is rejected too.
- `WEBHOOK_ALLOW_PRIVATE_URLS=true` lifts the network check. It's for local development only, and is set in `server/.env`, never in production.

**Limits.** At most 16 endpoints per merchant per mode. Deleting an endpoint is a soft delete: pending deliveries to it stop at their next attempt.

**Events API.** `GET /v1/events` and `GET /v1/events/{id}`, so merchants can recover from missed webhooks.

## Consequences

- Merchants get a verifiable, replay-resistant notification. Combined with `GET /v1/payment_intents/{id}`, they never need payer-supplied proof.
- **Residual SSRF risk:** DNS rebinding between our check and `fetch()`'s own resolution. The fix is to connect to the vetted IP, or to route webhooks through an egress proxy that enforces the policy. That's required before production.
- Deliveries reference `event_id` without a foreign key. `events` is partitioned on a microsecond `created_at` that a JS `Date` can't round-trip, and Postgres can't change a partition key's type. Events are append-only, so the reference stays valid.
- Still to come:
  - Secret rotation.
  - Manual redelivery.
  - Auto-disabling of dead endpoints (with merchant alerts).
  - A dashboard view of deliveries.
