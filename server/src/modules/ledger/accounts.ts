import { and, eq } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { ledgerAccounts } from "../../db/schema";
import { newId } from "../../lib/ids";
import { LedgerError } from "./errors";

export type AccountType = (typeof ledgerAccounts.$inferSelect)["type"];
export type Account = typeof ledgerAccounts.$inferSelect;

export type AccountSpec = {
  code: string;
  type: AccountType;
  merchantId?: string;
};

export const LEDGER_CURRENCY = "SDG";

/** Returns the account for (code, livemode), creating it if needed. */
export async function ensureAccount(
  tx: DbOrTx,
  spec: AccountSpec,
  livemode: boolean,
): Promise<Account> {
  await tx
    .insert(ledgerAccounts)
    .values({
      id: newId(),
      code: spec.code,
      type: spec.type,
      currency: LEDGER_CURRENCY,
      livemode,
      merchantId: spec.merchantId ?? null,
    })
    .onConflictDoNothing({
      target: [ledgerAccounts.code, ledgerAccounts.livemode],
    });

  const [account] = await tx
    .select()
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.code, spec.code),
        eq(ledgerAccounts.livemode, livemode),
      ),
    );
  if (!account) throw new Error(`ledger account ${spec.code} not found`);
  if (account.type !== spec.type) {
    throw new LedgerError(
      "account_type_mismatch",
      `account ${spec.code} is ${account.type}, expected ${spec.type}`,
    );
  }
  return account;
}
