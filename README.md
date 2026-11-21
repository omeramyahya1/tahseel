# Tahseel

Payment gateway for Sudan: merchant API, hosted checkout, and payment links on top of local payment rails.

## Layout

```
apps/
  web/        Astro + Starlight: marketing, pricing, docs        :4321
  dashboard/  Vite + React: merchant portal, onboarding, KYC     :5173
  checkout/   Vite + React: hosted payment page, payment links   :5174
  ops/        Vite + React: internal console (VPN-only)          :5175
server/
  src/modules/     payments, ledger, merchants, risk (strict boundaries)
  src/connectors/  one adapter per payment rail
  src/jobs/        outbox relay, webhooks, notifications, reconciliation
  src/api.ts       entrypoint: public API + app backends    :3000
  src/worker.ts    entrypoint: background jobs
  migrations/      Drizzle Kit migrations
packages/
  schemas/    Zod schemas shared by server and frontends
  sdk/        merchant SDK (generated from OpenAPI)
docs/adr/     architecture decision records
```

## Requirements

- Bun 1.4+
- Podman with `podman-compose`, for local PostgreSQL 18

## Getting started

```sh
bun install
cp server/.env.example server/.env   # then fill in the keys (openssl rand -base64 32)
bun run db:up
bun run dev:api      # http://localhost:3000/health
bun run dev:worker
bun run dev:web      # or dev:dashboard / dev:checkout / dev:ops
```

## Scripts

| Command             | What it does                          |
| ------------------- | ------------------------------------- |
| `bun run lint`      | Biome lint + format check             |
| `bun run format`    | Biome format (write)                  |
| `bun run typecheck` | Typecheck every workspace             |
| `bun run build`     | Build every workspace                 |
| `bun run test`      | Server tests (needs Postgres running) |
| `bun run db:up`     | Start local Postgres                  |
| `bun run db:down`   | Stop local Postgres                   |

Database migrations run from `server/`: `bun run db:generate`, `bun run db:migrate`.

## Notes

- `apps/web` runs Astro on the Bun runtime (`bun --bun astro`), and pins TypeScript 6 because `astro check` does not support TypeScript 7 yet. All other workspaces use TypeScript 7.

## License

Proprietary. All rights reserved. See [LICENSE](LICENSE).
