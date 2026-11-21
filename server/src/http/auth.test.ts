import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createTestDb } from "../../test/db";
import { createTestMerchant, testKeys } from "../../test/fixtures";
import { createApiKey, setMerchantStatus } from "../modules/merchants";
import { createApp } from "./app";
import { type AuthVariables, requireApiKey } from "./auth";
import { onError } from "./errors";

let t: Awaited<ReturnType<typeof createTestDb>>;
const keys = testKeys();
let app: Hono<{ Variables: AuthVariables }>;

beforeAll(async () => {
  t = await createTestDb();
  app = new Hono<{ Variables: AuthVariables }>();
  app.onError(onError);
  app.use("*", requireApiKey({ db: t.db, keys }));
  app.get("/whoami", (c) =>
    c.json({ merchant: c.var.merchant.id, livemode: c.var.livemode }),
  );
});

afterAll(async () => {
  await t.drop();
});

async function errorOf(res: Response) {
  return ((await res.json()) as { error: { code: string } }).error;
}

const get = (authorization?: string) =>
  app.request(
    "/whoami",
    authorization ? { headers: { authorization } } : undefined,
  );

describe("requireApiKey", () => {
  test("401 api_key_missing without a bearer token", async () => {
    for (const res of [await get(), await get("Basic abc")]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({
        error: {
          type: "authentication_error",
          code: "api_key_missing",
          message: expect.any(String),
        },
      });
    }
  });

  test("401 api_key_invalid for an unknown key", async () => {
    const res = await get("Bearer sk_test_nope");
    expect(res.status).toBe(401);
    expect((await errorOf(res)).code).toBe("api_key_invalid");
  });

  test("sets merchant and mode for a valid key", async () => {
    const m = await createTestMerchant(t.db);
    const { secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: true,
    });
    const res = await get(`Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ merchant: m.id, livemode: true });
  });

  test("403 merchant_suspended", async () => {
    const m = await createTestMerchant(t.db);
    const { secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    await setMerchantStatus(t.db, m.id, "suspended");
    const res = await get(`Bearer ${secret}`);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe("merchant_suspended");
  });
});

describe("createApp", () => {
  test("/v1 requires an API key; /health doesn't", async () => {
    const api = createApp({ db: t.db, keys });
    expect((await api.request("/health")).status).toBe(200);
    expect((await api.request("/health/db")).status).toBe(200);
    expect((await api.request("/v1/anything")).status).toBe(401);
  });

  test("unknown routes get a JSON 404", async () => {
    const api = createApp({ db: t.db, keys });
    const m = await createTestMerchant(t.db);
    const { secret } = await createApiKey(t.db, keys, {
      merchantId: m.id,
      livemode: false,
    });
    const res = await api.request("/v1/nothing_here", {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe("route_not_found");
  });
});
