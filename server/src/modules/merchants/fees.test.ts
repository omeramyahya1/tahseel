import { describe, expect, test } from "bun:test";
import { computeFee, type Pricing } from "./fees";

const p = (overrides: Partial<Pricing> = {}): Pricing => ({
  feeBps: 0,
  feeFixed: 0n,
  feeMin: null,
  feeMax: null,
  ...overrides,
});

describe("computeFee", () => {
  test("percent + fixed", () => {
    // 1.5% of 10,000.00 SDG (1,000,000 piasters) + 1.00 SDG
    expect(computeFee(1_000_000n, p({ feeBps: 150, feeFixed: 100n }))).toBe(
      15_100n,
    );
  });

  test("rounds half-up to whole piasters", () => {
    expect(computeFee(150n, p({ feeBps: 100 }))).toBe(2n); // 1.5 -> 2
    expect(computeFee(149n, p({ feeBps: 100 }))).toBe(1n); // 1.49 -> 1
    expect(computeFee(50n, p({ feeBps: 100 }))).toBe(1n); // 0.5 -> 1
    expect(computeFee(49n, p({ feeBps: 100 }))).toBe(0n);
  });

  test("clamps to min and max", () => {
    const pricing = p({ feeBps: 100, feeMin: 500n, feeMax: 10_000n });
    expect(computeFee(10_000n, pricing)).toBe(500n); // 100 -> min
    expect(computeFee(100_000n, pricing)).toBe(1_000n); // in range
    expect(computeFee(10_000_000n, pricing)).toBe(10_000n); // 100,000 -> max
  });

  test("never exceeds the amount", () => {
    expect(computeFee(300n, p({ feeFixed: 1_000n }))).toBe(300n);
    expect(computeFee(300n, p({ feeMin: 1_000n }))).toBe(300n);
  });

  test("zero pricing means zero fee", () => {
    expect(computeFee(1_000n, p())).toBe(0n);
  });

  test("handles amounts beyond Number.MAX_SAFE_INTEGER exactly", () => {
    const amount = 2n ** 60n;
    expect(computeFee(amount, p({ feeBps: 1 }))).toBe(
      (amount + 5_000n) / 10_000n,
    );
  });

  test("rejects non-positive amounts", () => {
    expect(() => computeFee(0n, p())).toThrow(RangeError);
  });
});
