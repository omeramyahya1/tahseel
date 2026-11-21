# CLAUDE.md

Guidance for Claude Code in this repository. Keep this file current: whenever a change affects anything described here (stack, layout, commands, conventions, decisions), update this file in the same change.

## Project

Tahseel is a Stripe-like payment gateway for Sudan. Merchants create payment requests (API, hosted checkout, payment links), payers pay over local rails (Bankak, Fawry, licensed mobile wallets, and later the CBoS National Instant Payment System, NIPS), and Tahseel confirms the payment, notifies the merchant (webhook first), and settles instantly or in batches (T+1/custom).

The problem it solves: today a Sudanese merchant confirms payment from a BBAN plus a screenshot or a transaction ID. Tahseel replaces that with rail-confirmed, API-verifiable payments.

- **Regulator:** Central Bank of Sudan (CBoS). Every bank or wallet integration needs CBoS prior written approval. Never launch anything publicly ahead of the regulator.
- **Standards target:** the CBoS 2014 switch-operator circular: PCI DSS, HSM-held keys, a unique ID per transaction, audit logs, fraud detection, separate DR and test environments, zero-downtime changes, disputes, a support centre, and **75 TPS** (load-test to about 5×).
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
- Each rail connector in `server/src/connectors/` implements one interface and gets its own queue, concurrency limit and circuit breaker.
- Keep Bun-only APIs out of the core, or behind interfaces, so the code can also run on Node.

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
- **Config:** env vars are validated in `server/src/env.ts`. Bun loads `.env` from the working directory, so the file lives at `server/.env` (template: `server/.env.example`).
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
```

Before you call a change done, run `bun run lint`, `bun run typecheck` and `bun run test`.

Tests (`bun test` in `server/`) run against real Postgres. `test/setup.ts` migrates a template database once, and each test file calls `createTestDb()` (`server/test/db.ts`) to get a fresh clone. Don't use transaction rollback for isolation: the deferred ledger triggers only fire at commit.

## Conventions

- Record significant decisions as a new ADR in `docs/adr/` (never edit an accepted one; supersede it).
- Every payment gets a ULID, stored alongside the rail's own reference.
- The public API follows Stripe's object model: payment intents, idempotency keys, signed webhooks, refunds, payouts.

## Open questions

Don't assume answers to these; ask.

- Is in-country hosting required? This affects the HSM (physical HSM vs cloud KMS), the database and DR.
- Which bank or wallet is the first rail, and does it give us an API, statement files, or only unique amounts for reconciliation?
- In phase 1, does money go direct to the merchant, or through a pooled collection account?
- Licensing path: technical provider under a licensed partner, our own FIMP licence, or a new PSP category.
