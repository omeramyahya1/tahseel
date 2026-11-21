import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

// SSRF guard for webhook URLs. Test mode runs on the same servers as live
// mode, so both are checked. Checked at creation and again before every
// delivery (DNS can change). Redirects are never followed.
//
// Residual risk: DNS rebinding between our lookup and fetch()'s own lookup.
// Closing it fully needs connecting to the vetted IP (or an egress proxy).

export type UrlPolicy = {
  /** Development only: allow loopback/private targets (local receivers). */
  allowPrivate: boolean;
  resolve?: (hostname: string) => Promise<string[]>;
};

const defaultResolve = async (hostname: string) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

function ipv4ToInt(ip: string): number {
  return (
    ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
  );
}

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (cloud metadata)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

function isBlockedV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return V4_BLOCKED.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) >>> 0 === (ipv4ToInt(base) & mask) >>> 0;
  });
}

/** Expands an IPv6 address (any notation, optional brackets) to 8 16-bit words. */
function expandIPv6(raw: string): number[] | null {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  // A trailing dotted IPv4 becomes two hex words.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
    ];
    ip = `${ip.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return null;
  const words = [...head, ...Array(missing).fill("0"), ...tail].map((w) =>
    Number.parseInt(w, 16),
  );
  return words.length === 8 && words.every((w) => w >= 0 && w <= 0xffff)
    ? words
    : null;
}

/** True for loopback, private, link-local, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family !== 6) return true; // not an IP: refuse
  const words = expandIPv6(ip);
  if (!words) return true;
  if (words.every((w) => w === 0)) return true; // ::
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d), in either
  // dotted or hex form: WHATWG URL rewrites [::ffff:127.0.0.1] to
  // [::ffff:7f00:1], so both must be checked as the embedded IPv4.
  if (
    words.slice(0, 5).every((w) => w === 0) &&
    (words[5] === 0xffff || words[5] === 0)
  ) {
    const hi = words[6] ?? 0;
    const lo = words[7] ?? 0;
    return isBlockedV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = words[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** Syntax and scheme rules. Returns an error message, or null if acceptable. */
export function checkUrlSyntax(raw: string, livemode: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "must use http or https";
  }
  if (livemode && url.protocol !== "https:") {
    return "must use https in live mode";
  }
  if (url.username || url.password) return "must not contain credentials";
  if (raw.length > 2048) return "must be at most 2048 characters";
  return null;
}

/** Resolves the host and rejects non-public targets. Returns an error message or null. */
export async function checkUrlTarget(
  raw: string,
  policy: UrlPolicy,
): Promise<string | null> {
  if (policy.allowPrivate) return null;
  const hostname = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "must not point to a private or loopback address";
  }
  let addresses: string[];
  if (isIP(hostname)) {
    addresses = [hostname];
  } else {
    try {
      addresses = await (policy.resolve ?? defaultResolve)(hostname);
    } catch {
      return "host could not be resolved";
    }
  }
  if (addresses.length === 0) return "host could not be resolved";
  if (addresses.some(isPrivateAddress)) {
    return "must not point to a private or loopback address";
  }
  return null;
}
