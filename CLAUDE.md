# CLAUDE.md

Guidance for Claude Code in this repository. Keep this file current: whenever a change affects anything described here (stack, layout, commands, conventions, decisions), update this file in the same change.

## Project

Tahseel is a Stripe-like payment gateway for Sudan. Merchants create payment requests (API, hosted checkout, payment links), payers pay over local rails (Bankak, Fawry, licensed mobile wallets, and later the CBoS National Instant Payment System, NIPS), and Tahseel confirms the payment, notifies the merchant (webhook first), and settles instantly or in batches (T+1/custom).

The problem it solves: today a Sudanese merchant confirms payment from a BBAN plus a screenshot or a transaction ID. Tahseel replaces that with rail-confirmed, API-verifiable payments.

- **Regulator:** Central Bank of Sudan (CBoS). Every bank or wallet integration needs CBoS prior written approval. Never launch anything publicly ahead of the regulator.
- **Standards target:** the CBoS 2014 switch-operator circular: HSM-held keys, a unique ID per transaction, audit logs, fraud detection, separate DR and test environments, zero-downtime changes, disputes, a support centre, and **75 TPS** (load-test to about 5×). Its "PCI DSS 2.1" and ISO 8583 items are read as described in `docs/adr/0004-security-and-standards-baseline.md`: **PCI DSS v4.0.1 controls as the baseline, with card data out of scope** (no PAN/CVV ever touches our systems). **ISO 20022** is the domain/messaging standard. ISO 8583 is deferred to a card connector, if one is ever needed.
- **Fund flow (v1): direct to merchant.** Payers pay straight into the merchant's own account. Tahseel never holds merchant funds; it confirms payments and **accrues fees** (per-merchant pricing: percent + fixed, min/max caps), billed separately.
- **Rails (MVP):** no real rail access yet (talks with NTC and EBS are in progress), so a **simulated rail** adapter stands in, test mode only.
- **NIPS:** ISO 20022 (pain.013 request-to-pay, pacs.002 status), EMVCo QR, alias directory. Model payments with ISO 20022 concepts so a NIPS connector is additive later.
- **Main competitor:** YallaPay (Istinara/Bravo).
- **Team:** one developer. Prefer the simplest thing that is operable by one person.

## Working rules

- **Ask, don't assume.** When a decision isn't settled by this file, the code or the user, ask before acting.
- **Git:** commit only when asked, never push unless asked, and add no attribution lines to commits or PRs.

## Non-negotiable payment invariants

- A payment counts as paid **only** when the rail confirms it (API status, statement line, pacs.002). Never trust anything the payer sends: screenshots, client callbacks, or transaction IDs the payer typed in.
- "Confirmed" and "reconciled" are separate facts. Settlement to merchants depends on reconciliation.
- A payment state change and its ledger journal entry commit in the **same database transaction**.
- Money is integer minor units: `bigint` in TypeScript, `BIGINT` in Postgres, and integers in the public API. Never use `number` or floats for amounts.
- Every amount carries its currency. **USD is a fully isolated ledger/database**, with no code path that posts across SDG and USD (CBoS FX restrictions).
- The ledger is the source of truth. Events are notifications; if an event and the ledger disagree, the ledger wins.
- Consumers are idempotent (at-least-once delivery, `event_id` dedupe). The public API uses idempotency keys.
- Sensitive ops actions (payouts, limit changes, large refunds) need two-person approval. Production access is audit-logged.

## Architecture

See `docs/adr/0002-initial-architecture.md`.

- Bun workspaces monorepo, TypeScript on Bun everywhere. Rust and Python stay off the production path.
- `server/` is a modular monolith with two entrypoints: `src/api.ts` (public API and app backends) and `src/worker.ts` (outbox relay, webhooks, notifications, reconciliation, rail polling).
- Modules in `server/src/modules/` (payments, ledger, merchants, risk) don't reach into each other's tables.
- Event-driven on Postgres: transactional outbox, `SELECT … FOR UPDATE SKIP LOCKED` job queue, partitioned append-only event log, all behind an `EventBus` interface. No external broker yet.
- `server/src/runtime.ts` is the composition root (db, keys, payments deps with the rail registry) shared by `api.ts` and `worker.ts`.
- Each rail connector in `server/src/connectors/` implements `RailConnector` and gets its own queue (`rail:<name>`) and concurrency limit. Circuit breakers aren't built yet.
- Keep Bun-only APIs out of the core, or behind interfaces, so the code can also run on Node.

### Ledger (`server/src/modules/ledger/`, ADR 0003)

- Append-only `ledger_accounts`, `ledger_journals` and `ledger_postings`. Amounts are signed `BIGINT` (debit +, credit −). Balances are always derived (`SUM`); there are no stored balance rows and no account locks.
- The DB enforces the invariants in `server/migrations/0001_ledger_invariants.sql`: `TL001` append-only, `TL002` ≥2 postings, `TL003` balanced per currency at commit, `TL004` postings only in the journal's own transaction. Composite FKs block cross-mode and cross-currency postings, and a CHECK makes the database SDG-only.
- Always post through `postJournal(tx, …)` inside the same transaction as the business state change. It's idempotent per `(source_type, source_id, kind)`. Corrections are new reversing journals, never edits.
- Accounts come from `chart` (`chart.ts`): memo `rail_inflow:{rail}` and `merchant_collected:{merchant}`, asset `fees_receivable:{merchant}`, revenue `fee_revenue`. Each exists separately per test/live mode.
- Hand-written SQL (triggers, functions) goes in custom migrations: `bunx drizzle-kit generate --custom --name <name>`.
- Drizzle Kit can't serialize `bigint` JS defaults (`0n`) into snapshots. Use ``.default(sql`0`)`` for BIGINT columns.
- Drizzle can't declare partitioned tables or triggers. Generate the migration, then hand-edit it (see `0004_events.sql`), or use a custom migration.
- DB-level SQLSTATE classes: `TL` ledger, `TP` payments, and `TA001` for generic append-only violations (`reject_append_only_mutation()`). Tests assert these codes with `pgErrorCode()`.

### Jobs and events (`server/src/jobs/`, `server/src/modules/events/`)

- `enqueue(tx, …)` writes a job **in the caller's transaction** (outbox). Workers claim with `SKIP LOCKED`. Delivery is at-least-once, so **handlers must be idempotent**. Use `dedupeKey` for one-per-thing jobs.
- Failures retry with exponential backoff and go `dead` after `max_attempts`. Throw `RetryLater(seconds)` to choose the delay. Use `drain(db, queue, handlers)` in tests.
- Publish events only through `EventBus.publish(tx, …)` in the same transaction as the change. It writes to `events` (monthly partitions + `events_default`) and a `dispatch_event` job, which the webhooks module fans out to endpoints. `data.object` is the public API representation, and `presentEvent()` is the event's public form (also the webhook body).
- **Timestamp precision:** Postgres `timestamptz` is microseconds and a JS `Date` is milliseconds. Never compare a DB timestamp after it has round-tripped through JS (cursors, composite keys). Compare in SQL against the row, as `listEvents()` does.

### Webhooks (`server/src/modules/webhooks/`, ADR 0006)

- Endpoints (`we_`) hold `enabled_events` (types or `*`) and an encrypted `whsec_` secret, returned once. Delete is soft. At most 16 per merchant per mode.
- Delivery: signed `POST` with `Tahseel-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>`. 10 s timeout, only 2xx succeeds, redirects aren't followed. Retries follow `RETRY_SCHEDULE_SECONDS` (13 attempts, about 2.7 days), then `failed`. Attempts are logged append-only.
- **SSRF:** every webhook URL goes through `checkUrlSyntax` + `checkUrlTarget` at creation **and before each delivery**: https in live mode, and no private, loopback or link-local targets (also after DNS). `WEBHOOK_ALLOW_PRIVATE_URLS=true` is for local dev only. DNS rebinding is still open: an egress proxy or IP pinning is needed before production.
- Queues: `events` (dispatch) and `webhooks` (delivery, concurrency 20), so slow merchant endpoints never block rails.

### Payments (`server/src/modules/payments/`, `server/src/connectors/`, ADR 0005)

- `payment_intents` (`pi_`), `payment_attempts` (`pa_`, one per confirm, i.e. one request-to-pay) and append-only `payment_intent_transitions`. Triggers enforce the state machine and immutable columns (keep `status.ts` and `0006_payments_invariants.sql` in sync).
- Confirm never calls a rail inline: it enqueues `request_to_pay` on `rail:<name>`. Rail reports, from callbacks or the simulator, are `rail_status` jobs handled by `applyRailStatus()`, which is idempotent per attempt.
- **Never expire a `processing` intent by our clock.** Only the rail's `expired` report does that. `expireDuePaymentIntents()` only touches `requires_confirmation`.
- Success commits status, fee (`computeFee`), ledger journal and event in one transaction.
- Simulated rail (test mode only), with outcome by payer alias: `+249900000001` succeeds, `…02` declines, `…03` never responds, `…04` unknown alias. Live mode has no rail (`503 rail_unavailable`).

### Merchants and API keys (`server/src/modules/merchants/`)

- `merchants` holds the ISO 20022 creditor account (`creditor_bank_code`, `creditor_account`) that payers pay directly, plus pricing (`fee_bps`, `fee_fixed`, `fee_min`, `fee_max`), all CHECK-constrained.
- Fees: `computeFee(amount, pricingOf(merchant))` uses bigint math, rounds half-up, clamps to min/max, and never returns more than the amount.
- API keys: `sk_test_`/`sk_live_` + 43 base62 chars. Only `HMAC-SHA256(pepper, secret)` (via `KeyProvider`) and `last4` are stored, and the secret is shown once. A key's mode is fixed at creation.
- No onboarding UI yet: `cd server && bun run create-merchant --name … --bank-code … --account … [--fee-bps --fee-fixed --fee-min --fee-max]` prints one test and one live key.

### HTTP (`server/src/http/`)

- `createApp({ db, keys })` builds the Hono app. `api.ts` only loads env and serves it, and tests call `app.request(...)` directly.
- Errors always use the Stripe-style envelope `{ error: { type, code, message, param? } }`: throw `ApiError(status, type, code, message, param?)`. Unknown routes return a JSON 404.
- Everything under `/v1` goes through `requireApiKey`, then `idempotency`. Handlers read `c.var.merchant`, `c.var.livemode` and `c.var.apiKey`, and **every query must be scoped by `(merchant_id, livemode)`**.
- Endpoints: `/v1/payment_intents` (create, retrieve, list, confirm, cancel), `/v1/events` (retrieve, list), `/v1/webhook_endpoints` (create, retrieve, list, delete).
- Routes use `@hono/zod-openapi` (`createRoute` + `app.openapi`) with schemas in `http/schemas.ts` and shared `security`/`errorResponses`/`ok` in `http/routes/common.ts`. Import `z` from `@hono/zod-openapi` there. The public spec is served at `/v1/openapi.json`.
- **Every POST requires `Idempotency-Key`.** State-changing handlers must wrap their work in `idempotentTx(c, db, status, tx => …)`, which stores the response in the same transaction.
- API conventions: amounts are integers (piasters), timestamps are ISO 8601 UTC, lists are `{ object: "list", data, has_more }` with `limit` and `starting_after`, and `currency` is `"SDG"`.
- Map domain errors to HTTP in `http/errors.ts` (`toApiError`), not in handlers.
- Validate internal IDs with `z.guid()`, never `z.uuid()`: our ULID-in-uuid values aren't RFC 4122, so `z.uuid()` rejects them at random.

## Layout

```
apps/web         Astro + Starlight: marketing, pricing, docs (/docs/)  :4321
apps/dashboard   Vite + React + Tailwind: merchant portal, onboarding  :5173
apps/checkout    Vite + React + Tailwind: hosted checkout, pay links   :5174
apps/ops         Vite + React + Tailwind: internal console (VPN-only)  :5175
server           Hono API + worker, Drizzle                            :3000
packages/schemas Zod schemas shared by server and frontends
packages/sdk     merchant SDK (to be generated from OpenAPI)
docs/adr         architecture decision records
```

Merchant onboarding and KYC belong in `apps/dashboard`, never in the public marketing site.

## Stack

- **Server:** Hono, postgres.js, Drizzle ORM, Drizzle Kit (migrations in `server/migrations`, schema in `server/src/db/schema.ts`), Zod v4. The plan is `@hono/zod-openapi` (code-first OpenAPI, which feeds the docs and the SDK).
- **Database:** PostgreSQL 18 via `docker-compose.yml`, run with **Podman** (`podman compose`). The image comes from `public.ecr.aws/docker/library/postgres` because Docker Hub blob downloads return 403 from this network.
- **Config:** env vars are validated in `server/src/env.ts`. Bun loads `.env` from the working directory, so the file lives at `server/.env` (template: `server/.env.example`). Vars: `DATABASE_URL`, `API_PORT`, `API_KEY_PEPPER`, `SECRETS_ENCRYPTION_KEY`, `WEBHOOK_ALLOW_PRIVATE_URLS` (dev only), `TEST_DATABASE_ADMIN_URL` (tests).
- **Crypto:** all key operations go through `KeyProvider` (`server/src/crypto/keys.ts`): HMAC for API keys, AES-256-GCM for stored secrets. It's env-backed today and is the seam for an HSM/KMS later.
- **DB access:** `createDb()` and `withTx()` in `server/src/db/client.ts`. BIGINT comes back as `bigint`; `withTx` retries serialization and deadlock errors. Module functions take a `Db`/`Tx` argument instead of importing a singleton.
- **Frontend:** React 19, Vite 8, Tailwind 4 (`@tailwindcss/vite`).
- **Lint/format:** Biome (`biome.json`). Markdown is excluded from Biome. Two-space indent, double quotes.
- **TypeScript:** 7 everywhere except `apps/web`, which pins TS 6 because `astro check` doesn't support TS 7. Shared strict settings in `tsconfig.base.json` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`).
- `apps/web` runs Astro on the Bun runtime (`bun --bun astro …`), because Astro 7.4 needs Node ≥ 22.23.4.

## Commands

Run from the repo root unless noted.

```sh
bun install
bun run db:up / db:down               # local Postgres (Podman)
bun run test                          # server tests (needs db:up)
bun run dev:api | dev:worker | dev:web | dev:dashboard | dev:checkout | dev:ops
bun run lint                          # Biome check; `bun run format` to write
bun run typecheck                     # all workspaces
bun run build                         # all workspaces
cd server && bun run db:generate | db:migrate | db:studio
cd server && bun run create-merchant --name … --bank-code … --account …
```

Before you call a change done, run `bun run lint`, `bun run typecheck` and `bun run test`.

Tests (`bun test` in `server/`) run against real Postgres. `test/setup.ts` migrates a template database once, and each test file calls `createTestDb()` (`server/test/db.ts`) to get a fresh clone. `server/test/fixtures.ts` provides `testKeys()`, `createTestMerchant()` (ledger accounts with a `merchant_id` need a real merchant) `testPaymentsDeps()` (the simulated rail responds immediately) and `testAppDeps()` (full app deps, with webhooks allowed to hit localhost receivers). HTTP tests use `Bun.serve({ port: 0 })` as a webhook receiver. Use `must()` from `server/test/assert.ts` instead of `!`. Don't use transaction rollback for isolation: the deferred ledger triggers only fire at commit.

## Conventions

- Record significant decisions as a new ADR in `docs/adr/` (never edit an accepted one; supersede it).
- IDs are ULIDs (`newId()` in `server/src/lib/ids.ts`), stored in `uuid` columns and exposed as prefixed public IDs (`toPublicId("pi", id)` → `pi_01J…`). Every payment stores the rail's own reference alongside its ID.
- Drizzle uses `casing: "snake_case"`: write camelCase in `schema.ts`, and the columns are snake_case.
- The public API follows Stripe's object model: payment intents, idempotency keys, signed webhooks, refunds, payouts.

## Open questions

Don't assume answers to these; ask.

- Is in-country hosting required? This affects the HSM (physical HSM vs cloud KMS), the database and DR.
- Which bank or wallet is the first real rail (NTC/EBS talks are ongoing), and does it give us an API, statement files, or only unique amounts for reconciliation?
- Licensing path: technical provider under a licensed partner, our own FIMP licence, or a new PSP category.
