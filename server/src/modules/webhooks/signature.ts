import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Tahseel-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>
// Receivers recompute v1 over the raw body and reject old timestamps.

export const SIGNATURE_HEADER = "Tahseel-Signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export function signWebhook(
  secret: string,
  body: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`;
}

/** Reference verifier (what merchants implement; also used in tests). */
export function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string,
  options: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  const parts = new Map(
    header.split(",").map((kv) => {
      const i = kv.indexOf("=");
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get("t"));
  const v1 = parts.get("v1");
  if (!Number.isInteger(t) || !v1) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (
    Math.abs(now - t) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)
  ) {
    return false;
  }
  const expected = Buffer.from(hmac(secret, t, body), "hex");
  const given = Buffer.from(v1, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
