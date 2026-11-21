-- Statement-level TRUNCATE triggers on a partitioned table don't fire for
-- `TRUNCATE <partition>`, so every partition needs its own guard. (Row-level
-- UPDATE/DELETE triggers are cloned to partitions automatically.)
--
-- Note: an owner can still DROP or DETACH a partition. That's in the same
-- class as disabling triggers, and is closed by separate DB roles (planned).

CREATE FUNCTION guard_event_partitions() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  part regclass;
  trigger_name text;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent = 'events'::regclass
  LOOP
    trigger_name := format('%s_no_truncate', part::text);
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger WHERE tgrelid = part AND tgname = trigger_name
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation()',
        trigger_name, part
      );
    END IF;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ensure_event_partitions(months_ahead int) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  month_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  i int;
  lo date;
  hi date;
  name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ensure_event_partitions'));
  FOR i IN 0..months_ahead LOOP
    lo := (month_start + make_interval(months => i))::date;
    hi := (month_start + make_interval(months => i + 1))::date;
    name := format('events_y%sm%s', to_char(lo, 'YYYY'), to_char(lo, 'MM'));
    IF to_regclass(name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
        name, lo::timestamp AT TIME ZONE 'UTC', hi::timestamp AT TIME ZONE 'UTC'
      );
    END IF;
  END LOOP;
  -- Guards new partitions, and repairs any that are missing their guard.
  PERFORM guard_event_partitions();
END;
$$;
--> statement-breakpoint
SELECT guard_event_partitions();
