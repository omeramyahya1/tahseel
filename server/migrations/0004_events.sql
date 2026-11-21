CREATE TABLE "events" (
	"id" uuid NOT NULL,
	"type" text NOT NULL,
	"merchant_id" uuid NOT NULL,
	"livemode" boolean NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_created_at_id_pk" PRIMARY KEY("created_at","id")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_id_idx" ON "events" USING btree ("id");--> statement-breakpoint
CREATE INDEX "events_merchant_idx" ON "events" USING btree ("merchant_id","livemode","created_at");--> statement-breakpoint
-- Hand-written below (Drizzle can't express partitioning or triggers).

-- Generic append-only guard for non-ledger tables. SQLSTATE TA001.
CREATE FUNCTION reject_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'TA001';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER events_no_truncate
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
-- Safety net: rows land here if a monthly partition is ever missing, so an
-- event write never fails a payment transaction. It should stay empty;
-- creating a partition for a range that has rows here will error loudly.
CREATE TABLE events_default PARTITION OF events DEFAULT;
--> statement-breakpoint
-- Creates monthly partitions events_yYYYYmMM from this month through
-- `months_ahead` months ahead. Safe to call concurrently and repeatedly.
CREATE FUNCTION ensure_event_partitions(months_ahead int) RETURNS void
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
END;
$$;
--> statement-breakpoint
SELECT ensure_event_partitions(2);
