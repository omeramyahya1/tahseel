-- Ledger invariants enforced by the database (see docs/adr/0003-ledger-design.md).
--
-- Custom SQLSTATEs (class "TL", Tahseel Ledger):
--   TL001  ledger rows are append-only (UPDATE / DELETE / TRUNCATE)
--   TL002  journal has fewer than 2 postings at commit
--   TL003  journal postings don't sum to zero (per currency) at commit
--   TL004  posting added to a journal created by an earlier transaction

-- 1. Append-only -------------------------------------------------------------

CREATE FUNCTION ledger_reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger is append-only: % on % is not allowed', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'TL001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_append_only
  BEFORE UPDATE OR DELETE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_accounts_no_truncate
  BEFORE TRUNCATE ON ledger_accounts
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_journals_append_only
  BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_journals_no_truncate
  BEFORE TRUNCATE ON ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_postings_append_only
  BEFORE UPDATE OR DELETE ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ledger_postings_no_truncate
  BEFORE TRUNCATE ON ledger_postings
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_reject_mutation();
--> statement-breakpoint

-- 2. Postings only in the journal's own transaction ---------------------------
-- now() is the transaction start time, so forcing journals.created_at to now()
-- lets a posting trigger check that its journal was created in this transaction.
-- Without this, a balanced pair could be appended to an old, closed journal.

CREATE FUNCTION ledger_journal_stamp_created_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_journals_stamp_created_at
  BEFORE INSERT ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION ledger_journal_stamp_created_at();
--> statement-breakpoint
CREATE FUNCTION ledger_posting_same_tx() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  journal_created_at timestamptz;
BEGIN
  SELECT created_at INTO journal_created_at FROM ledger_journals WHERE id = NEW.journal_id;
  -- A missing journal is left to the foreign key to report.
  IF FOUND AND journal_created_at <> now() THEN
    RAISE EXCEPTION 'cannot add postings to journal % after it was committed', NEW.journal_id
      USING ERRCODE = 'TL004';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_postings_same_tx
  BEFORE INSERT ON ledger_postings
  FOR EACH ROW EXECUTE FUNCTION ledger_posting_same_tx();
--> statement-breakpoint

-- 3. Balanced journals, checked at COMMIT ------------------------------------

CREATE FUNCTION ledger_check_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  jid uuid;
  posting_count int;
BEGIN
  IF TG_TABLE_NAME = 'ledger_journals' THEN
    jid := NEW.id;
  ELSE
    jid := NEW.journal_id;
  END IF;

  SELECT count(*) INTO posting_count FROM ledger_postings WHERE journal_id = jid;
  IF posting_count < 2 THEN
    RAISE EXCEPTION 'journal % has % posting(s); at least 2 are required', jid, posting_count
      USING ERRCODE = 'TL002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM ledger_postings
    WHERE journal_id = jid
    GROUP BY currency
    HAVING sum(amount) <> 0
  ) THEN
    RAISE EXCEPTION 'journal % is unbalanced: postings must sum to zero per currency', jid
      USING ERRCODE = 'TL003';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_journals_balanced
  AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_journal_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_postings_balanced
  AFTER INSERT ON ledger_postings
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_check_journal_balanced();
