-- Payment invariants enforced by the database. Mirrors the TypeScript
-- transition tables in server/src/modules/payments/status.ts.
--
-- Custom SQLSTATEs (class "TP", Tahseel Payments):
--   TP001  invalid payment intent status transition
--   TP002  immutable payment intent column changed
--   TP003  invalid payment attempt status transition
--   TP004  immutable payment attempt column changed

ALTER TABLE payment_intents
  ADD CONSTRAINT payment_intents_latest_attempt_fk
  FOREIGN KEY (latest_attempt_id) REFERENCES payment_attempts(id);
--> statement-breakpoint

-- 1. Payment intents -----------------------------------------------------------

CREATE FUNCTION payment_intents_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
     OR NEW.livemode IS DISTINCT FROM OLD.livemode
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.fee IS NOT NULL AND NEW.fee IS DISTINCT FROM OLD.fee)
  THEN
    RAISE EXCEPTION 'payment intent %: immutable column changed', OLD.id
      USING ERRCODE = 'TP002';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'requires_confirmation' AND NEW.status IN ('processing', 'canceled', 'expired'))
    OR (OLD.status = 'processing' AND NEW.status IN ('succeeded', 'requires_confirmation', 'expired'))
  ) THEN
    RAISE EXCEPTION 'payment intent %: invalid transition % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'TP001';
  END IF;

  -- A succeeded intent always carries its fee.
  IF NEW.status = 'succeeded' AND NEW.fee IS NULL THEN
    RAISE EXCEPTION 'payment intent %: succeeded without a fee', OLD.id
      USING ERRCODE = 'TP001';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_intents_guard_update
  BEFORE UPDATE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payment_intents_guard_update();
--> statement-breakpoint
CREATE FUNCTION payment_intents_guard_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'requires_confirmation' THEN
    RAISE EXCEPTION 'payment intents must be created as requires_confirmation'
      USING ERRCODE = 'TP001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_intents_guard_insert
  BEFORE INSERT ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION payment_intents_guard_insert();
--> statement-breakpoint
CREATE TRIGGER payment_intents_no_delete
  BEFORE DELETE ON payment_intents
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_intents_no_truncate
  BEFORE TRUNCATE ON payment_intents
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint

-- 2. Payment attempts ------------------------------------------------------------

CREATE FUNCTION payment_attempts_guard_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id
     OR NEW.livemode IS DISTINCT FROM OLD.livemode
     OR NEW.rail IS DISTINCT FROM OLD.rail
     OR NEW.payer_alias IS DISTINCT FROM OLD.payer_alias
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.rail_reference IS NOT NULL AND NEW.rail_reference IS DISTINCT FROM OLD.rail_reference)
  THEN
    RAISE EXCEPTION 'payment attempt %: immutable column changed', OLD.id
      USING ERRCODE = 'TP004';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('sent', 'succeeded', 'declined', 'expired'))
    OR (OLD.status = 'sent' AND NEW.status IN ('succeeded', 'declined', 'expired'))
  ) THEN
    RAISE EXCEPTION 'payment attempt %: invalid transition % -> %', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'TP003';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_attempts_guard_update
  BEFORE UPDATE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION payment_attempts_guard_update();
--> statement-breakpoint
CREATE TRIGGER payment_attempts_no_delete
  BEFORE DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_attempts_no_truncate
  BEFORE TRUNCATE ON payment_attempts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint

-- 3. Transition history is append-only ----------------------------------------

CREATE TRIGGER payment_intent_transitions_append_only
  BEFORE UPDATE OR DELETE ON payment_intent_transitions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_intent_transitions_no_truncate
  BEFORE TRUNCATE ON payment_intent_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
