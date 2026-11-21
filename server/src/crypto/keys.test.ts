import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createEnvKeyProvider } from "./keys";

const keys = createEnvKeyProvider({
  apiKeyPepper: randomBytes(32).toString("base64"),
  secretsEncryptionKey: randomBytes(32).toString("base64"),
});

describe("KeyProvider (env)", () => {
  test("encrypt/decrypt round-trips and uses a fresh IV", () => {
    const a = keys.encrypt("whsec_secret");
    const b = keys.encrypt("whsec_secret");
    expect(a.equals(b)).toBe(false);
    expect(keys.decrypt(a)).toBe("whsec_secret");
  });

  test("tampered ciphertext is rejected", () => {
    const c = keys.encrypt("whsec_secret");
    c[c.length - 1] = (c[c.length - 1] ?? 0) ^ 0xff;
    expect(() => keys.decrypt(c)).toThrow();
  });

  test("hmac is deterministic per pepper", () => {
    expect(
      keys.hmacApiKey("sk_test_x").equals(keys.hmacApiKey("sk_test_x")),
    ).toBe(true);
    const other = createEnvKeyProvider({
      apiKeyPepper: randomBytes(32).toString("base64"),
      secretsEncryptionKey: randomBytes(32).toString("base64"),
    });
    expect(
      other.hmacApiKey("sk_test_x").equals(keys.hmacApiKey("sk_test_x")),
    ).toBe(false);
  });
});
