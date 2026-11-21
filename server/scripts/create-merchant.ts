// Creates a merchant with pricing and prints one test and one live API key.
// Stand-in for dashboard onboarding. Keys are shown once and never stored.
//
//   bun scripts/create-merchant.ts --name "Acme" --bank-code BOK \
//     --account 1234567890 [--fee-bps 150] [--fee-fixed 100] \
//     [--fee-min 50] [--fee-max 500000]
//
// Fee amounts are in piasters (minor units).

import { parseArgs } from "node:util";
import { createEnvKeyProvider } from "../src/crypto/keys";
import { createDb, withTx } from "../src/db/client";
import { loadEnv } from "../src/env";
import { createApiKey, createMerchant } from "../src/modules/merchants";

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    "bank-code": { type: "string" },
    account: { type: "string" },
    "fee-bps": { type: "string", default: "0" },
    "fee-fixed": { type: "string", default: "0" },
    "fee-min": { type: "string" },
    "fee-max": { type: "string" },
  },
});

const name = values.name;
const bankCode = values["bank-code"];
const account = values.account;
if (!name || !bankCode || !account) {
  console.error("Required: --name, --bank-code, --account");
  process.exit(1);
}

const toBigInt = (v: string | undefined) =>
  v === undefined ? null : BigInt(v);

const env = loadEnv();
const { db, sql } = createDb(env.DATABASE_URL, { max: 1 });
const keys = createEnvKeyProvider({
  apiKeyPepper: env.API_KEY_PEPPER,
  secretsEncryptionKey: env.SECRETS_ENCRYPTION_KEY,
});

try {
  const result = await withTx(db, async (tx) => {
    const merchant = await createMerchant(tx, {
      name,
      creditorBankCode: bankCode,
      creditorAccount: account,
      pricing: {
        feeBps: Number.parseInt(values["fee-bps"], 10),
        feeFixed: BigInt(values["fee-fixed"]),
        feeMin: toBigInt(values["fee-min"]),
        feeMax: toBigInt(values["fee-max"]),
      },
    });
    const test = await createApiKey(tx, keys, {
      merchantId: merchant.id,
      livemode: false,
    });
    const live = await createApiKey(tx, keys, {
      merchantId: merchant.id,
      livemode: true,
    });
    return { merchant, test: test.secret, live: live.secret };
  });

  console.log(`Merchant: ${result.merchant.name} (${result.merchant.id})`);
  console.log(`Test key: ${result.test}`);
  console.log(`Live key: ${result.live}`);
  console.log("Store these keys now; they can't be shown again.");
} finally {
  await sql.end();
}
