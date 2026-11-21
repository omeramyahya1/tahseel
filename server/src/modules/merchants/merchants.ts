import { eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { merchants } from "../../db/schema";
import { newId } from "../../lib/ids";
import type { Pricing } from "./fees";

export type Merchant = typeof merchants.$inferSelect;

export type CreateMerchantInput = {
  name: string;
  creditorBankCode: string;
  creditorAccount: string;
  pricing?: Partial<Pricing>;
};

export async function createMerchant(
  tx: DbOrTx,
  input: CreateMerchantInput,
): Promise<Merchant> {
  const [merchant] = await tx
    .insert(merchants)
    .values({
      id: newId(),
      name: input.name,
      creditorBankCode: input.creditorBankCode,
      creditorAccount: input.creditorAccount,
      feeBps: input.pricing?.feeBps ?? 0,
      feeFixed: input.pricing?.feeFixed ?? 0n,
      feeMin: input.pricing?.feeMin ?? null,
      feeMax: input.pricing?.feeMax ?? null,
    })
    .returning();
  if (!merchant) throw new Error("failed to create merchant");
  return merchant;
}

export async function getMerchant(
  db: DbOrTx,
  id: string,
): Promise<Merchant | undefined> {
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.id, id));
  return merchant;
}

export async function setMerchantStatus(
  tx: DbOrTx,
  id: string,
  status: Merchant["status"],
): Promise<void> {
  await tx
    .update(merchants)
    .set({ status, updatedAt: new Date() })
    .where(eq(merchants.id, id));
}

export function pricingOf(merchant: Merchant): Pricing {
  return {
    feeBps: merchant.feeBps,
    feeFixed: merchant.feeFixed,
    feeMin: merchant.feeMin,
    feeMax: merchant.feeMax,
  };
}
