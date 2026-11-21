import { randomBytes } from "node:crypto";

// IDs are ULIDs (48-bit ms timestamp + 80 random bits), stored in Postgres
// `uuid` columns and exposed publicly as `<prefix>_<26-char ULID>`.

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DECODE = new Map([...ALPHABET].map((ch, i) => [ch, BigInt(i)]));
const MAX_128 = (1n << 128n) - 1n;

export function newId(now: number = Date.now()): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(now, 0, 6);
  randomBytes(10).copy(bytes, 6);
  return toUuid(bytes);
}

function toUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidToUlid(uuid: string): string {
  let n = BigInt(`0x${uuid.replaceAll("-", "")}`);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = ALPHABET[Number(n & 31n)] + out;
    n >>= 5n;
  }
  return out;
}

export function ulidToUuid(ulid: string): string | null {
  if (ulid.length !== 26) return null;
  let n = 0n;
  for (const ch of ulid.toUpperCase()) {
    const v = DECODE.get(ch);
    if (v === undefined) return null;
    n = (n << 5n) | v;
  }
  if (n > MAX_128) return null;
  return toUuid(Buffer.from(n.toString(16).padStart(32, "0"), "hex"));
}

export function toPublicId(prefix: string, uuid: string): string {
  return `${prefix}_${uuidToUlid(uuid)}`;
}

/** Returns the internal uuid, or null if the ID is malformed or has the wrong prefix. */
export function fromPublicId(prefix: string, publicId: string): string | null {
  if (!publicId.startsWith(`${prefix}_`)) return null;
  return ulidToUuid(publicId.slice(prefix.length + 1));
}
