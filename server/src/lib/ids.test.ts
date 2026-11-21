import { describe, expect, test } from "bun:test";
import { fromPublicId, newId, toPublicId, ulidToUuid, uuidToUlid } from "./ids";

describe("ids", () => {
  test("round-trips uuid <-> ULID <-> public ID", () => {
    const id = newId();
    const ulid = uuidToUlid(id);
    expect(ulid).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect(ulidToUuid(ulid)).toBe(id);
    expect(fromPublicId("pi", toPublicId("pi", id))).toBe(id);
  });

  test("IDs sort by creation time", () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(uuidToUlid(a) < uuidToUlid(b)).toBe(true);
    expect(a < b).toBe(true);
  });

  test("rejects malformed or wrong-prefix IDs", () => {
    const pub = toPublicId("pi", newId());
    expect(fromPublicId("evt", pub)).toBeNull();
    expect(fromPublicId("pi", "pi_short")).toBeNull();
    expect(fromPublicId("pi", "pi_8ZZZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull(); // > 128 bits
    expect(fromPublicId("pi", "pi_0000000000000000000000000U")).toBeNull(); // invalid char
  });
});
