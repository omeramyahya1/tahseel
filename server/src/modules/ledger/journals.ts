import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "../../db/client";
import { ledgerJournals, ledgerPostings } from "../../db/schema";
import { newId } from "../../lib/ids";
import { type AccountSpec, ensureAccount, LEDGER_CURRENCY } from "./accounts";
import { LedgerError } from "./errors";

export type Journal = typeof ledgerJournals.$inferSelect;
export type Posting = typeof ledgerPostings.$inferSelect;

export type PostingInput = {
  account: AccountSpec;
  /** Minor units. Debit is positive, credit is negative. */
  amount: bigint;
};

export type JournalInput = {
  kind: string;
  livemode: boolean;
  /** The business object this journal records. One journal per (source, kind). */
  source: { type: string; id: string };
  description?: string;
  postings: PostingInput[];
};

export type PostJournalResult = { journal: Journal; created: boolean };

/**
 * Posts a balanced journal inside the caller's transaction. Idempotent per
 * (source, kind): posting again returns the existing journal unchanged.
 *
 * The rules are checked here for a clear error, and again by the database
 * at commit (migrations/0001_ledger_invariants.sql).
 */
export async function postJournal(
  tx: Tx,
  input: JournalInput,
): Promise<PostJournalResult> {
  validate(input);

  const [inserted] = await tx
    .insert(ledgerJournals)
    .values({
      id: newId(),
      kind: input.kind,
      livemode: input.livemode,
      sourceType: input.source.type,
      sourceId: input.source.id,
      description: input.description ?? null,
    })
    .onConflictDoNothing({
      target: [
        ledgerJournals.sourceType,
        ledgerJournals.sourceId,
        ledgerJournals.kind,
      ],
    })
    .returning();

  if (!inserted) {
    const [existing] = await tx
      .select()
      .from(ledgerJournals)
      .where(
        and(
          eq(ledgerJournals.sourceType, input.source.type),
          eq(ledgerJournals.sourceId, input.source.id),
          eq(ledgerJournals.kind, input.kind),
        ),
      );
    if (!existing) throw new Error("journal conflict but no existing row");
    return { journal: existing, created: false };
  }

  const rows = [];
  for (const p of input.postings) {
    const account = await ensureAccount(tx, p.account, input.livemode);
    rows.push({
      id: newId(),
      journalId: inserted.id,
      accountId: account.id,
      amount: p.amount,
      currency: LEDGER_CURRENCY,
      livemode: input.livemode,
    });
  }
  await tx.insert(ledgerPostings).values(rows);

  return { journal: inserted, created: true };
}

function validate(input: JournalInput) {
  if (input.postings.length < 2) {
    throw new LedgerError(
      "too_few_postings",
      "a journal needs at least 2 postings",
    );
  }
  let sum = 0n;
  for (const p of input.postings) {
    if (typeof p.amount !== "bigint" || p.amount === 0n) {
      throw new LedgerError(
        "invalid_amount",
        "posting amounts must be non-zero bigint minor units",
      );
    }
    sum += p.amount;
  }
  if (sum !== 0n) {
    throw new LedgerError("unbalanced", `postings sum to ${sum}, expected 0`);
  }
}

export async function getJournalPostings(
  db: DbOrTx,
  journalId: string,
): Promise<Posting[]> {
  return db
    .select()
    .from(ledgerPostings)
    .where(eq(ledgerPostings.journalId, journalId));
}

/**
 * Raw signed balance (sum of postings): positive is a net debit. Debit-normal
 * accounts (asset, memo collected) read it as is; credit-normal accounts
 * (revenue, liability, memo inflow) read the negation.
 */
export async function getBalance(
  db: DbOrTx,
  accountId: string,
): Promise<bigint> {
  const [row] = await db
    .select({
      // SUM(bigint) is numeric; keep it as text so totals beyond the BIGINT
      // range don't overflow before BigInt() parses them.
      balance: sql<string>`coalesce(sum(${ledgerPostings.amount}), 0)::text`,
    })
    .from(ledgerPostings)
    .where(eq(ledgerPostings.accountId, accountId));
  return BigInt(row?.balance ?? 0);
}
