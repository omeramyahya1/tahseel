import { describe, expect, test } from "bun:test";
import { signWebhook, verifyWebhookSignature } from ".";

describe("webhook signatures", () => {
  const secret = "whsec_test";
  const body = '{"id":"evt_1"}';

  test("a signature verifies against the same body and secret", () => {
    expect(
      verifyWebhookSignature(secret, body, signWebhook(secret, body)),
    ).toBe(true);
  });

  test("tampered body, wrong secret or garbage header fail", () => {
    const header = signWebhook(secret, body);
    expect(verifyWebhookSignature(secret, `${body} `, header)).toBe(false);
    expect(verifyWebhookSignature("whsec_other", body, header)).toBe(false);
    expect(verifyWebhookSignature(secret, body, "nonsense")).toBe(false);
    expect(verifyWebhookSignature(secret, body, "t=1,v1=zz")).toBe(false);
  });

  test("old timestamps are rejected (replay protection)", () => {
    const t = 1_800_000_000;
    const header = signWebhook(secret, body, t);
    expect(verifyWebhookSignature(secret, body, header, { now: t + 299 })).toBe(
      true,
    );
    expect(verifyWebhookSignature(secret, body, header, { now: t + 301 })).toBe(
      false,
    );
  });

  test("header format is t=<unix>,v1=<64 hex chars>", () => {
    expect(signWebhook(secret, body, 1_800_000_000)).toMatch(
      /^t=1800000000,v1=[0-9a-f]{64}$/,
    );
  });
});
