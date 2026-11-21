# 2. Initial architecture

Date: 2026-11-21

## Status

Accepted

## Context

A solo developer is building a payment gateway that must meet CBoS switch-operator standards (audit logging, unique transaction IDs, fraud detection, DR and test environments, zero-downtime changes, disputes, 75 TPS). Every extra runtime or service adds operational load for one person.

## Decision

- **Monorepo** with Bun workspaces: `apps/*` (web, dashboard, checkout, ops), `server`, `packages/*` (schemas, sdk).
- **One language:** TypeScript on Bun throughout. Rust and Python stay off the production path for now.
- **Two deployables from one server codebase:** `api` and `worker`.
- **Money core is a modular monolith:** payments, ledger, merchants and risk live in one deployable on one PostgreSQL database, with strict module boundaries. A payment state change and its ledger entry commit in the same database transaction.
- **Event-driven on Postgres:** transactional outbox, a job queue using `SELECT … FOR UPDATE SKIP LOCKED`, and a partitioned append-only event log. Publishing sits behind an `EventBus` interface, so a broker (Redpanda or NATS) can replace it later without changing consumers.
- **Stack:** Hono (HTTP), postgres.js (driver), Drizzle ORM and Drizzle Kit (schema and migrations), Zod with generated OpenAPI. Astro + Starlight for marketing and docs. Vite + React + Tailwind for the frontends. Biome for lint and format.
- **Money representation:** integer minor units (`bigint` in TypeScript, `BIGINT` in Postgres), never floating point.
- **Currency isolation:** USD, when added, gets a fully separate ledger database with no cross-currency code path.

## Consequences

- Minimal infrastructure to operate: one database plus two app processes.
- Ledger correctness is enforced by Postgres transactions and constraints rather than service coordination.
- Hono and postgres.js run on both Bun and Node, so the runtime can be swapped if Bun has a production issue. Bun-only APIs must stay out of the core or sit behind interfaces.
- Splitting services out later is possible thanks to module boundaries and the `EventBus` abstraction.
