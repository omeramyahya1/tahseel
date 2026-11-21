import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb } from "../../../test/db";
import { createTestMerchant } from "../../../test/fixtures";
import { pgErrorCode, withTx } from "../../db/client";
import { newId } from "../../lib/ids";
import {
  chart,
  ensureAccount,
  getBalance,
  getJournalPostings,
  LedgerError,
  postJournal,
} from ".";

let t: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await t.drop();
});

const merchant = async () => (await createTestMerchant(t.db)).id;

function feeJournal(merchantId: string, fee: bigint, sourceId = newId()) {
  return {
    kind: "test_fee",
    livemode: false,
    source: { type: "test", id: sourceId },
    postings: [
      { account: chart.feesReceivable(merchantId), amount: fee },
      { account: chart.feeRevenue(), amount: -fee },
    ],
  };
}

async function expectSqlState(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (err) {
    expect(pgErrorCode(err)).toBe(code);
    return;
  }
  throw new Error(`expected SQLSTATE ${code}, but the operation succeeded`);
}

/** Inserts accounts/journal/postings with raw SQL, bypassing app validation. */
async function rawJournal(
  postings: { accountId: string; amount: bigint; livemode?: boolean }[],
  journalLivemode = false,
) {
  await t.sql.begin(async (sql) => {
    const jid = newId();
    await sql`insert into ledger_journals (id, kind, livemode, source_type, source_id)
              values (${jid}, 'raw', ${journalLivemode}, 'raw', ${newId()})`;
    for (const p of postings) {
      await sql`insert into ledger_postings (id, journal_id, account_id, amount, currency, livemode)
                values (${newId()}, ${jid}, ${p.accountId}, ${p.amount}, 'SDG', ${p.livemode ?? journalLivemode})`;
    }
  });
}

async function accounts(livemode = false) {
  const m = await merchant();
  const a = await ensureAccount(t.db, chart.feesReceivable(m), livemode);
  const b = await ensureAccount(t.db, chart.feeRevenue(), livemode);
  return { a, b };
}

describe("postJournal", () => {
  test("posts a balanced journal and derives balances", async () => {
    const m = await merchant();
    const { journal, created } = await withTx(t.db, (tx) =>
      postJournal(tx, feeJournal(m, 150n)),
    );
    expect(created).toBe(true);

    const postings = await getJournalPostings(t.db, journal.id);
    expect(postings.map((p) => p.amount).sort()).toEqual([-150n, 150n]);

    const receivable = await ensureAccount(
      t.db,
      chart.feesReceivable(m),
      false,
    );
    expect(await getBalance(t.db, receivable.id)).toBe(150n);

    await withTx(t.db, (tx) => postJournal(tx, feeJournal(m, 50n)));
    expect(await getBalance(t.db, receivable.id)).toBe(200n);
  });

  test("is idempotent per (source, kind)", async () => {
    const m = await merchant();
    const source = newId();
    const first = await withTx(t.db, (tx) =>
      postJournal(tx, feeJournal(m, 100n, source)),
    );
    const second = await withTx(t.db, (tx) =>
      postJournal(tx, feeJournal(m, 100n, source)),
    );
    expect(second.created).toBe(false);
    expect(second.journal.id).toBe(first.journal.id);

    const receivable = await ensureAccount(
      t.db,
      chart.feesReceivable(m),
      false,
    );
    expect(await getBalance(t.db, receivable.id)).toBe(100n);
  });

  test("rejects unbalanced, single-posting and zero-amount journals in the app", async () => {
    const m = await merchant();
    const unbalanced = feeJournal(m, 100n);
    unbalanced.postings[1] = { account: chart.feeRevenue(), amount: -99n };
    await expect(
      withTx(t.db, (tx) => postJournal(tx, unbalanced)),
    ).rejects.toBeInstanceOf(LedgerError);

    const single = { ...feeJournal(m, 100n), postings: [] as never[] };
    await expect(withTx(t.db, (tx) => postJournal(tx, single))).rejects.toThrow(
      "at least 2 postings",
    );

    await expect(
      withTx(t.db, (tx) => postJournal(tx, feeJournal(m, 0n))),
    ).rejects.toThrow("non-zero");
  });

  test("keeps test and live accounts separate", async () => {
    const live = await ensureAccount(t.db, chart.feeRevenue(), true);
    const test_ = await ensureAccount(t.db, chart.feeRevenue(), false);
    expect(live.id).not.toBe(test_.id);
  });

  test("rejects reusing an account code with a different type", async () => {
    const m = await merchant();
    await ensureAccount(t.db, chart.feesReceivable(m), false);
    await expect(
      ensureAccount(
        t.db,
        { code: `fees_receivable:${m}`, type: "revenue" },
        false,
      ),
    ).rejects.toThrow("expected revenue");
  });
});

describe("database invariants", () => {
  test("TL003: unbalanced journal is rejected at commit", async () => {
    const { a, b } = await accounts();
    await expectSqlState(
      rawJournal([
        { accountId: a.id, amount: 100n },
        { accountId: b.id, amount: -99n },
      ]),
      "TL003",
    );
  });

  test("TL002: single-posting journal is rejected at commit", async () => {
    const { a } = await accounts();
    await expectSqlState(
      rawJournal([{ accountId: a.id, amount: 100n }]),
      "TL002",
    );
  });

  test("TL002: journal with no postings is rejected at commit", async () => {
    await expectSqlState(rawJournal([]), "TL002");
  });

  test("TL004: postings can't be appended to a committed journal", async () => {
    const m = await merchant();
    const { journal } = await withTx(t.db, (tx) =>
      postJournal(tx, feeJournal(m, 10n)),
    );
    const { a, b } = await accounts();
    await expectSqlState(
      t.sql.begin(async (sql) => {
        await sql`insert into ledger_postings (id, journal_id, account_id, amount, currency, livemode)
                  values (${newId()}, ${journal.id}, ${a.id}, 5, 'SDG', false),
                         (${newId()}, ${journal.id}, ${b.id}, -5, 'SDG', false)`;
      }),
      "TL004",
    );
  });

  test("TL001: ledger rows can't be updated, deleted or truncated", async () => {
    const m = await merchant();
    const { journal } = await withTx(t.db, (tx) =>
      postJournal(tx, feeJournal(m, 10n)),
    );
    await expectSqlState(
      t.sql`update ledger_postings set amount = amount * 2 where journal_id = ${journal.id}`,
      "TL001",
    );
    await expectSqlState(
      t.sql`delete from ledger_postings where journal_id = ${journal.id}`,
      "TL001",
    );
    await expectSqlState(
      t.sql`update ledger_journals set kind = 'x' where id = ${journal.id}`,
      "TL001",
    );
    await expectSqlState(
      t.sql`delete from ledger_journals where id = ${journal.id}`,
      "TL001",
    );
    await expectSqlState(
      t.sql`update ledger_accounts set code = code`,
      "TL001",
    );
    await expectSqlState(t.sql`truncate ledger_postings cascade`, "TL001");
    await expectSqlState(t.sql`truncate ledger_journals cascade`, "TL001");
  });

  test("a posting can't mix modes with its account (FK)", async () => {
    const { a, b } = await accounts(false);
    await expectSqlState(
      rawJournal(
        [
          { accountId: a.id, amount: 100n, livemode: true },
          { accountId: b.id, amount: -100n, livemode: true },
        ],
        true,
      ),
      "23503",
    );
  });

  test("a posting can't mix modes with its journal (FK)", async () => {
    const { a, b } = await accounts(false);
    await expectSqlState(
      rawJournal(
        [
          { accountId: a.id, amount: 100n, livemode: false },
          { accountId: b.id, amount: -100n, livemode: false },
        ],
        true,
      ),
      "23503",
    );
  });

  test("non-SDG accounts are rejected", async () => {
    await expectSqlState(
      t.sql`insert into ledger_accounts (id, code, type, currency, livemode)
            values (${newId()}, 'usd_test', 'asset', 'USD', false)`,
      "23514",
    );
  });

  test("zero-amount postings are rejected", async () => {
    const { a, b } = await accounts();
    await expectSqlState(
      rawJournal([
        { accountId: a.id, amount: 0n },
        { accountId: b.id, amount: 0n },
      ]),
      "23514",
    );
  });

  test("journal created_at can't be backdated", async () => {
    const [row] = await t.sql.begin(async (sql) => {
      const jid = newId();
      await sql`insert into ledger_journals (id, kind, livemode, source_type, source_id, created_at)
                values (${jid}, 'raw', false, 'raw', ${newId()}, '2000-01-01')`;
      const { a, b } = await accounts();
      await sql`insert into ledger_postings (id, journal_id, account_id, amount, currency, livemode)
                values (${newId()}, ${jid}, ${a.id}, 1, 'SDG', false),
                       (${newId()}, ${jid}, ${b.id}, -1, 'SDG', false)`;
      return sql`select created_at, now() as now from ledger_journals where id = ${jid}`;
    });
    expect(row?.created_at).toEqual(row?.now);
  });
});
