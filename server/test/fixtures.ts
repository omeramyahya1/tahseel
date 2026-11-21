import { randomBytes } from "node:crypto";
import { createEnvKeyProvider } from "../src/crypto/keys";
import type { Db, DbOrTx } from "../src/db/client";
import { newId } from "../src/lib/ids";
import {
  type CreateMerchantInput,
  createMerchant,
} from "../src/modules/merchants";
import { createPaymentsDeps } from "../src/runtime";

export function testKeys() {
  return createEnvKeyProvider({
    apiKeyPepper: randomBytes(32).toString("base64"),
    secretsEncryptionKey: randomBytes(32).toString("base64"),
  });
}

export function createTestMerchant(
  db: DbOrTx,
  overrides: Partial<CreateMerchantInput> = {},
) {
  return createMerchant(db, {
    name: `Test merchant ${newId().slice(-6)}`,
    creditorBankCode: "TESTBANK",
    creditorAccount: "0000000000000001",
    ...overrides,
  });
}

/** Payments deps with the simulated rail responding immediately. */
export function testPaymentsDeps(db: Db) {
  return createPaymentsDeps(db, { simulatedResponseDelayMs: 0 });
}
