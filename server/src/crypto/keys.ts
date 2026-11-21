import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

/**
 * Key operations behind one interface so the env-backed implementation can be
 * swapped for an HSM or KMS without touching callers.
 */
export interface KeyProvider {
  /** HMAC-SHA256 with the API key pepper. Used to hash API keys at rest. */
  hmacApiKey(value: string): Buffer;
  /** AES-256-GCM. Output: version byte | 12-byte IV | 16-byte tag | ciphertext. */
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function createEnvKeyProvider(config: {
  apiKeyPepper: string;
  secretsEncryptionKey: string;
}): KeyProvider {
  const pepper = Buffer.from(config.apiKeyPepper, "base64");
  const encKey = Buffer.from(config.secretsEncryptionKey, "base64").subarray(
    0,
    32,
  );
  if (pepper.length < 32)
    throw new Error("API key pepper must be at least 32 bytes");
  if (encKey.length !== 32)
    throw new Error("Secrets encryption key must be 32 bytes");

  return {
    hmacApiKey(value) {
      return createHmac("sha256", pepper).update(value).digest();
    },
    encrypt(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", encKey, iv);
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([
        Buffer.from([VERSION]),
        iv,
        cipher.getAuthTag(),
        body,
      ]);
    },
    decrypt(ciphertext) {
      if (ciphertext[0] !== VERSION)
        throw new Error("Unsupported ciphertext version");
      const iv = ciphertext.subarray(1, 1 + IV_BYTES);
      const tag = ciphertext.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
      const body = ciphertext.subarray(1 + IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString(
        "utf8",
      );
    },
  };
}
