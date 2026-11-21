import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Column names are snake_case via `casing: "snake_case"` (client + drizzle.config).
// Ledger invariants that Drizzle can't express (balanced journals, append-only)
// live in custom SQL migrations; see docs/adr/0003-ledger-design.md.

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export const ledgerAccountType = pgEnum("ledger_account_type", [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
  "memo",
]);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid().primaryKey(),
    code: text().notNull(),
    type: ledgerAccountType().notNull(),
    currency: char({ length: 3 }).notNull(),
    livemode: boolean().notNull(),
    merchantId: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_accounts_code_livemode_key").on(t.code, t.livemode),
    unique("ledger_accounts_id_currency_livemode_key").on(
      t.id,
      t.currency,
      t.livemode,
    ),
    // This database holds the SDG ledger only. USD gets its own database.
    check("ledger_accounts_currency_sdg", sql`${t.currency} = 'SDG'`),
  ],
);

export const ledgerJournals = pgTable(
  "ledger_journals",
  {
    id: uuid().primaryKey(),
    kind: text().notNull(),
    livemode: boolean().notNull(),
    sourceType: text().notNull(),
    sourceId: text().notNull(),
    description: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("ledger_journals_id_livemode_key").on(t.id, t.livemode),
    // One journal of each kind per source object: re-posting is a no-op.
    unique("ledger_journals_source_kind_key").on(
      t.sourceType,
      t.sourceId,
      t.kind,
    ),
  ],
);

export const ledgerPostings = pgTable(
  "ledger_postings",
  {
    id: uuid().primaryKey(),
    journalId: uuid().notNull(),
    accountId: uuid().notNull(),
    // Minor units. Debit is positive, credit is negative.
    amount: bigint({ mode: "bigint" }).notNull(),
    currency: char({ length: 3 }).notNull(),
    livemode: boolean().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("ledger_postings_amount_nonzero", sql`${t.amount} <> 0`),
    // Composite FKs: a posting can't mix modes with its journal, or mix
    // currency/mode with its account.
    foreignKey({
      name: "ledger_postings_journal_fk",
      columns: [t.journalId, t.livemode],
      foreignColumns: [ledgerJournals.id, ledgerJournals.livemode],
    }),
    foreignKey({
      name: "ledger_postings_account_fk",
      columns: [t.accountId, t.currency, t.livemode],
      foreignColumns: [
        ledgerAccounts.id,
        ledgerAccounts.currency,
        ledgerAccounts.livemode,
      ],
    }),
    index("ledger_postings_account_id_idx").on(t.accountId),
    index("ledger_postings_journal_id_idx").on(t.journalId),
  ],
);
