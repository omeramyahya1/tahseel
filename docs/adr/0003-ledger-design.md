# 3. Ledger design

Date: 2026-11-21

## Status

Accepted

## Context

Tahseel needs a ledger that CBoS and auditors can trust and that one developer can operate. In v1, funds go **directly from the payer to the merchant's account**. Tahseel never holds merchant money; it confirms payments and earns fees, billed separately. A widely shared tutorial design (stored balances updated under `SELECT … FOR UPDATE`, `NUMERIC` amounts, balance enforced only in app code) was reviewed and rejected: it models a retail bank, enforces too little in the database, and serialises every operation on a hot settlement account.

## Decision

**Structure.** Three append-only tables: `ledger_accounts`, `ledger_journals` and `ledger_postings`. A journal is one business event. Its postings carry signed `BIGINT` minor-unit amounts: debit is positive, credit is negative.

**Invariants enforced by PostgreSQL** (`server/migrations/0001_ledger_invariants.sql`):

| Rule | Mechanism | SQLSTATE |
|---|---|---|
| No `UPDATE`, `DELETE` or `TRUNCATE` on ledger tables | `BEFORE` row and statement triggers | `TL001` |
| A journal has ≥ 2 postings | Deferred constraint trigger, checked at `COMMIT` | `TL002` |
| A journal's postings sum to 0 per currency | Deferred constraint trigger, checked at `COMMIT` | `TL003` |
| Postings can only be added in the journal's own transaction | `created_at` forced to `now()` + `BEFORE INSERT` check | `TL004` |
| Non-zero amounts | `CHECK` | `23514` |
| SDG only in this database | `CHECK (currency = 'SDG')` | `23514` |
| A posting can't mix test/live mode or currency with its account or journal | Composite foreign keys | `23503` |

The app (`postJournal`) validates the same rules first, so callers get clear errors.

**Idempotency.** `(source_type, source_id, kind)` is unique. Posting the same business event twice returns the existing journal.

**No stored balances.** A balance is `SUM(amount)` over the account's postings, indexed by `account_id`. Since Tahseel holds no funds, there are no insufficient-funds checks, so no account rows need locking. That means no hot-account contention and no deadlocks. A snapshot or rollup table can be added later if read volume demands it; it would be a cache, verified against the postings.

**Chart of accounts (direct flow), one set per mode:**

| Account | Type | Meaning |
|---|---|---|
| `rail_inflow:{rail}` | memo | Funds a rail moved from payers to merchants, as confirmed by the rail |
| `merchant_collected:{merchant}` | memo | Funds a merchant received directly through Tahseel |
| `fees_receivable:{merchant}` | asset | Fees the merchant owes Tahseel |
| `fee_revenue` | revenue | Tahseel's fee income |

A succeeded payment posts:
- Dr `merchant_collected` / Cr `rail_inflow`, both for the amount.
- Dr `fees_receivable` / Cr `fee_revenue`, both for the fee, when the fee is non-zero.

The memo pair keeps the volume Tahseel vouched for in double-entry form, so it can be reconciled against rail statements. It never touches Tahseel's balance sheet.

**Currency isolation.** USD, if CBoS ever permits it, gets a separate database with its own ledger. No code path posts across currencies.

## Consequences

- An application bug can't silently corrupt the books: the transaction fails at commit.
- Corrections are reversing journals, never edits.
- Tests can't isolate via transaction rollback (the deferred checks would never run), so each test file uses a fresh database cloned from a migrated template.
- A database owner can still disable triggers. Separate DB roles (migration owner vs. an app role without `UPDATE`/`DELETE`/`TRUNCATE`/`TRIGGER`) and a hash-chained audit log are planned hardening.
- If Tahseel later holds funds (pooled settlement), the chart gains real liability accounts (merchant pending/available), and balance checks with ordered row locks will be needed.
