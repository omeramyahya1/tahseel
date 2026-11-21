import { createRailRegistry, createSimulatedRail } from "./connectors";
import { createEnvKeyProvider } from "./crypto/keys";
import { createDb, type Db } from "./db/client";
import type { Env } from "./env";
import { pgEventBus } from "./modules/events";
import type { PaymentsDeps } from "./modules/payments";

// Composition root shared by api.ts and worker.ts.

export function createPaymentsDeps(
  db: Db,
  options: { simulatedResponseDelayMs?: number } = {},
): PaymentsDeps {
  return {
    bus: pgEventBus,
    rails: createRailRegistry({
      test: createSimulatedRail({
        db,
        ...(options.simulatedResponseDelayMs !== undefined
          ? { responseDelayMs: options.simulatedResponseDelayMs }
          : {}),
      }),
      // No live rail until NTC/EBS API access exists.
      live: null,
    }),
  };
}

export function createRuntime(env: Env) {
  const { db, sql } = createDb(env.DATABASE_URL);
  const keys = createEnvKeyProvider({
    apiKeyPepper: env.API_KEY_PEPPER,
    secretsEncryptionKey: env.SECRETS_ENCRYPTION_KEY,
  });
  return { db, sql, keys, payments: createPaymentsDeps(db) };
}
