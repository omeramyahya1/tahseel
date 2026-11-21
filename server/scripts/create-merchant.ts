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

function parse() {
  return parseArgs({
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
}

let values: ReturnType<typeof parse>["values"];
try {
  values = parse().values;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const name = values.name;
const bankCode = values["bank-code"];
const account = values.account;
if (!name || !bankCode || !account) {
  console.error("Required: --name, --bank-code, --account");
  process.exit(1);
}

// Validate whole values (no partial parses like parseInt("1.5") === 1)
// before connecting to the database.
function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseBps(raw: string): number {
  if (!/^\d+$/.test(raw)) fail(`--fee-bps must be an integer, got "${raw}"`);
  const bps = Number(raw);
  if (bps > 10_000) fail(`--fee-bps must be between 0 and 10000, got ${bps}`);
  return bps;
}

function parsePiasters(flag: string, raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    fail(`--${flag} must be a non-negative integer (piasters), got "${raw}"`);
  }
  return BigInt(raw);
}

const optionalPiasters = (flag: string, raw: string | undefined) =>
  raw === undefined ? null : parsePiasters(flag, raw);

const pricing = {
  feeBps: parseBps(values["fee-bps"]),
  feeFixed: parsePiasters("fee-fixed", values["fee-fixed"]),
  feeMin: optionalPiasters("fee-min", values["fee-min"]),
  feeMax: optionalPiasters("fee-max", values["fee-max"]),
};
if (
  pricing.feeMin !== null &&
  pricing.feeMax !== null &&
  pricing.feeMin > pricing.feeMax
) {
  fail("--fee-min must not exceed --fee-max");
}

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
      pricing,
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
