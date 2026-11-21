-- TL004 used to compare the journal's created_at with now(). Two different
-- transactions that start in the same microsecond share now(), so a later
-- transaction could append postings to a committed journal. The journal now
-- records its creator's top-level transaction ID (pg_current_xact_id(),
-- which is the same inside savepoints), and postings must come from it.
-- Existing journals keep NULL here: they're committed, so any new posting
-- to them is rejected, which is correct.

ALTER TABLE "ledger_journals" ADD COLUMN "created_xact_id" "xid8";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_journal_stamp_created_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.created_at := now();
  NEW.created_xact_id := pg_current_xact_id();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_posting_same_tx() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  creator xid8;
BEGIN
  SELECT created_xact_id INTO creator FROM ledger_journals WHERE id = NEW.journal_id;
  -- A missing journal is left to the foreign key to report.
  IF FOUND AND creator IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'cannot add postings to journal % outside the transaction that created it', NEW.journal_id
      USING ERRCODE = 'TL004';
  END IF;
  RETURN NEW;
END;
$$;
