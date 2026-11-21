export type Pricing = {
  feeBps: number;
  feeFixed: bigint;
  feeMin: bigint | null;
  feeMax: bigint | null;
};

/**
 * fee = amount * bps / 10_000 (rounded half-up) + fixed, clamped to
 * [min, max], and never more than the amount itself. All in minor units.
 */
export function computeFee(amount: bigint, pricing: Pricing): bigint {
  if (amount <= 0n) throw new RangeError("amount must be positive");
  const bps = BigInt(pricing.feeBps);
  let fee = (amount * bps + 5_000n) / 10_000n + pricing.feeFixed;
  if (pricing.feeMin !== null && fee < pricing.feeMin) fee = pricing.feeMin;
  if (pricing.feeMax !== null && fee > pricing.feeMax) fee = pricing.feeMax;
  return fee > amount ? amount : fee;
}
