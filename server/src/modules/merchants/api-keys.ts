import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { KeyProvider } from "../../crypto/keys";
import type { DbOrTx } from "../../db/client";
import { apiKeys, merchants } from "../../db/schema";
import { newId } from "../../lib/ids";
import type { Merchant } from "./merchants";

export type ApiKey = typeof apiKeys.$inferSelect;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SECRET_PATTERN = /^sk_(test|live)_[0-9A-Za-z]{43}$/;

function base62(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = BASE62[Number(n % 62n)] + out;
    n /= 62n;
  }
  // 32 bytes need at most 43 base62 digits; pad so every key has one length.
  return out.padStart(43, "0");
}

export function generateSecret(livemode: boolean): string {
  return `sk_${livemode ? "live" : "test"}_${base62(randomBytes(32))}`;
}

/** Creates an API key. The returned secret is shown once and never stored. */
export async function createApiKey(
  tx: DbOrTx,
  keys: KeyProvider,
  input: { merchantId: string; livemode: boolean },
): Promise<{ apiKey: ApiKey; secret: string }> {
  const secret = generateSecret(input.livemode);
  const [apiKey] = await tx
    .insert(apiKeys)
    .values({
      id: newId(),
      merchantId: input.merchantId,
      livemode: input.livemode,
      keyHash: keys.hmacApiKey(secret),
      last4: secret.slice(-4),
    })
    .returning();
  if (!apiKey) throw new Error("failed to create API key");
  return { apiKey, secret };
}

export async function revokeApiKey(
  tx: DbOrTx,
  input: { merchantId: string; apiKeyId: string },
): Promise<boolean> {
  const rows = await tx
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, input.apiKeyId),
        eq(apiKeys.merchantId, input.merchantId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

export type AuthResult =
  | { ok: true; merchant: Merchant; apiKey: ApiKey; livemode: boolean }
  | { ok: false; reason: "invalid" | "revoked" | "merchant_suspended" };

export async function authenticateApiKey(
  db: DbOrTx,
  keys: KeyProvider,
  secret: string,
): Promise<AuthResult> {
  const match = SECRET_PATTERN.exec(secret);
  if (!match) return { ok: false, reason: "invalid" };

  const [row] = await db
    .select({ apiKey: apiKeys, merchant: merchants })
    .from(apiKeys)
    .innerJoin(merchants, eq(merchants.id, apiKeys.merchantId))
    .where(eq(apiKeys.keyHash, keys.hmacApiKey(secret)));

  if (!row) return { ok: false, reason: "invalid" };
  // The prefix must agree with the stored mode.
  if (row.apiKey.livemode !== (match[1] === "live")) {
    return { ok: false, reason: "invalid" };
  }
  if (row.apiKey.revokedAt) return { ok: false, reason: "revoked" };
  if (row.merchant.status !== "active") {
    return { ok: false, reason: "merchant_suspended" };
  }
  return {
    ok: true,
    merchant: row.merchant,
    apiKey: row.apiKey,
    livemode: row.apiKey.livemode,
  };
}
