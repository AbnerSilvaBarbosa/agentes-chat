ALTER TABLE "issue_columns" ADD COLUMN "waits_for_person" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "column_since" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- A task sits in its column since its last status change, else since it was made (ADR 0184).
UPDATE "issues" SET "column_since" = coalesce(
  (SELECT max(a."created_at") FROM "issue_activity" a WHERE a."issue_id" = "issues"."id" AND a."event" = 'status_changed'),
  "issues"."created_at"
);--> statement-breakpoint
-- The previous version, still serving during a deploy (or after a rollback), writes status, column and board without
-- naming `column_since`: this keeps it for every writer. `agentes.keep_column_since` = on, set inside a transaction,
-- lets a re-pointing of a task to another row of the same column keep its clock.
CREATE FUNCTION "issues_column_since"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('agentes.keep_column_since', true), '') <> 'on' AND (
    NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."column_id" IS DISTINCT FROM OLD."column_id"
    OR NEW."project_id" IS DISTINCT FROM OLD."project_id"
  ) THEN
    NEW."column_since" := now();
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER "issues_column_since" BEFORE UPDATE ON "issues"
  FOR EACH ROW EXECUTE FUNCTION "issues_column_since"();
