import { describe, expect, test } from "bun:test";
import { checkUrlSyntax, checkUrlTarget, isPrivateAddress } from ".";

describe("isPrivateAddress", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("%s is blocked", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  test.each(["8.8.8.8", "172.32.0.1", "196.29.160.1", "2001:4860:4860::8888"])(
    "%s is public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("checkUrlSyntax", () => {
  test("live mode requires https; test mode allows http", () => {
    expect(checkUrlSyntax("http://example.com/h", true)).toContain("https");
    expect(checkUrlSyntax("http://example.com/h", false)).toBeNull();
    expect(checkUrlSyntax("https://example.com/h", true)).toBeNull();
  });

  test("rejects other schemes, relative URLs and embedded credentials", () => {
    expect(checkUrlSyntax("ftp://example.com", false)).not.toBeNull();
    expect(checkUrlSyntax("/hooks", false)).not.toBeNull();
    expect(checkUrlSyntax("https://u:p@example.com", false)).not.toBeNull();
  });
});

describe("checkUrlTarget", () => {
  const resolve = (map: Record<string, string[]>) => async (h: string) =>
    map[h] ?? [];

  test("rejects private IP literals, localhost and hosts resolving to private IPs", async () => {
    const policy = {
      allowPrivate: false,
      resolve: resolve({
        "internal.example": ["10.0.0.5"],
        "mixed.example": ["8.8.8.8", "127.0.0.1"],
      }),
    };
    for (const url of [
      "http://127.0.0.1:8080/x",
      "http://[::1]/x",
      "http://localhost/x",
      "http://api.localhost/x",
      "http://internal.example/x",
      "http://mixed.example/x",
      "http://unresolvable.example/x",
    ]) {
      expect(await checkUrlTarget(url, policy)).not.toBeNull();
    }
  });

  test("accepts public hosts", async () => {
    const policy = {
      allowPrivate: false,
      resolve: resolve({ "shop.example": ["93.184.216.34"] }),
    };
    expect(
      await checkUrlTarget("https://shop.example/hooks", policy),
    ).toBeNull();
  });

  test("allowPrivate (development) skips the check", async () => {
    expect(
      await checkUrlTarget("http://localhost:4000/x", { allowPrivate: true }),
    ).toBeNull();
  });

  test("IPv4-mapped/compatible IPv6 is checked as the embedded IPv4 (dotted and hex)", async () => {
    const policy = { allowPrivate: false };
    for (const url of [
      "http://[::ffff:127.0.0.1]/x", // URL rewrites this to [::ffff:7f00:1]
      "http://[::ffff:7f00:1]/x",
      "http://[::ffff:a00:1]/x", // 10.0.0.1
      "http://[::ffff:a9fe:a9fe]/x", // 169.254.169.254 (metadata)
      "http://[::ffff:c0a8:101]/x", // 192.168.1.1
      "http://[::7f00:1]/x", // IPv4-compatible loopback
      "http://[0:0:0:0:0:ffff:7f00:1]/x",
    ]) {
      expect(await checkUrlTarget(url, policy)).not.toBeNull();
    }
    for (const url of [
      "https://[2001:4860:4860::8888]/x",
      "https://[::ffff:808:808]/x", // 8.8.8.8
    ]) {
      expect(await checkUrlTarget(url, policy)).toBeNull();
    }
  });
});
