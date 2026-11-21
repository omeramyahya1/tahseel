import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/db";
import { createTestMerchant, testKeys } from "../../../test/fixtures";
import { pgErrorCode } from "../../db/client";
import {
  authenticateApiKey,
  createApiKey,
  generateSecret,
  pricingOf,
  revokeApiKey,
  setMerchantStatus,
} from ".";

let t: Awaited<ReturnType<typeof createTestDb>>;
const keys = testKeys();

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.drop();
});

async function expectSqlState(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (err) {
    expect(pgErrorCode(err)).toBe(code);
    return;
  }
  throw new Error(`expected SQLSTATE ${code}, but the operation succeeded`);
}

describe("merchants", () => {
  test("creates a merchant with pricing", async () => {
    const m = await createTestMerchant(t.db, {
      pricing: { feeBps: 150, feeFixed: 100n, feeMin: 50n, feeMax: 5_000n },
    });
    expect(m.status).toBe("active");
    expect(pricingOf(m)).toEqual({
      feeBps: 150,
      feeFixed: 100n,
      feeMin: 50n,
      feeMax: 5_000n,
    });
  });

  test("the database rejects invalid pricing", async () => {
    await expectSqlState(
      createTestMerchant(t.db, { pricing: { feeBps: 10_001 } }),
      "23514",
    );
    await expectSqlState(
      createTestMerchant(t.db, { pricing: { feeFixed: -1n } }),
      "23514",
    );
    await expectSqlState(
      createTestMerchant(t.db, { pricing: { feeMin: 10n, feeMax: 5n } }),
      "23514",
    );
    await expectSqlState(
      createTestMerchant(t.db, { pricing: { feeMax: -1n } }),
      "23514",
    );
  });

  test("the database rejects a blank creditor account", async () => {
    await expectSqlState(
      createTestMerchant(t.db, { creditorAccount: "  " }),
      "23514",
    );
  });
});

describe("API keys", () => {
  test("secrets have the documented format", () => {
    expect(generateSecret(false)).toMatch(/^sk_test_[0-9A-Za-z]{43}$/);
    expect(generateSecret(true)).toMatch(/^sk_live_[0-9A-Za-z]{43}$/);
  });

  test("only the HMAC of the secret is stored", async () => {
    const m = await createTestMerchant(t.db);
    const { apiKey, secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    expect(apiKey.keyHash.equals(keys.hmacApiKey(secret))).toBe(true);
    expect(apiKey.last4).toBe(secret.slice(-4));
    const [row] =
      await t.sql`select count(*)::int as n from api_keys where key_hash::text like ${`%${secret}%`}`;
    expect(row?.n).toBe(0);
  });

  test("authenticates test and live keys with the right mode", async () => {
    const m = await createTestMerchant(t.db);
    const testKey = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    const liveKey = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: true,
    });

    const a = await authenticateApiKey(t.db, keys, testKey.secret);
    const b = await authenticateApiKey(t.db, keys, liveKey.secret);
    expect(a.ok && a.livemode).toBe(false);
    expect(a.ok && a.merchant.id).toBe(m.id);
    expect(b.ok && b.livemode).toBe(true);
  });

  test("rejects unknown, malformed and wrong-pepper keys", async () => {
    expect(await authenticateApiKey(t.db, keys, generateSecret(false))).toEqual(
      { ok: false, reason: "invalid" },
    );
    expect(await authenticateApiKey(t.db, keys, "sk_test_short")).toEqual({
      ok: false,
      reason: "invalid",
    });

    const m = await createTestMerchant(t.db);
    const { secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    expect(await authenticateApiKey(t.db, testKeys(), secret)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("rejects a key whose prefix doesn't match its stored mode", async () => {
    const m = await createTestMerchant(t.db);
    const { secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    // Simulate a stored row whose mode disagrees with the key's prefix.
    const forged = secret.replace("sk_test_", "sk_live_");
    await t.sql`update api_keys set key_hash = ${keys.hmacApiKey(forged)} where key_hash = ${keys.hmacApiKey(secret)}`;
    expect(await authenticateApiKey(t.db, keys, forged)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  test("rejects revoked keys", async () => {
    const m = await createTestMerchant(t.db);
    const { apiKey, secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    expect(
      await revokeApiKey(t.db, { merchantId: m.id, apiKeyId: apiKey.id }),
    ).toBe(true);
    expect(
      await revokeApiKey(t.db, { merchantId: m.id, apiKeyId: apiKey.id }),
    ).toBe(false);
    expect(await authenticateApiKey(t.db, keys, secret)).toEqual({
      ok: false,
      reason: "revoked",
    });
  });

  test("a merchant can't revoke another merchant's key", async () => {
    const owner = await createTestMerchant(t.db);
    const other = await createTestMerchant(t.db);
    const { apiKey, secret } = await createApiKey(t.db, keys, {
      merchantId: owner.id,
      livemode: false,
    });
    expect(
      await revokeApiKey(t.db, { merchantId: other.id, apiKeyId: apiKey.id }),
    ).toBe(false);
    expect((await authenticateApiKey(t.db, keys, secret)).ok).toBe(true);
  });

  test("rejects keys of suspended merchants", async () => {
    const m = await createTestMerchant(t.db);
    const { secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    await setMerchantStatus(t.db, m.id, "suspended");
    expect(await authenticateApiKey(t.db, keys, secret)).toEqual({
      ok: false,
      reason: "merchant_suspended",
    });
  });
});
