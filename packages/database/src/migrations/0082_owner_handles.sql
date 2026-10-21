-- Metadata-only expansion. Population-dependent work belongs to 0083, after this
-- transaction releases its ACCESS EXCLUSIVE lock. Historical address text is not rewritten.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
CREATE TABLE "project_handle_counters" (
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"n" integer NOT NULL,
	CONSTRAINT "project_handle_counters_project_id_kind_pk" PRIMARY KEY("project_id","kind"),
	CONSTRAINT "project_handle_counters_kind_valid" CHECK ("project_handle_counters"."kind" IN ('thread', 'work'))
);
--> statement-breakpoint
ALTER TABLE "project_handle_counters" ADD CONSTRAINT "project_handle_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "handle" text;
--> statement-breakpoint
-- Both concurrent creation and the backfill allocate from the same row. This temporary
-- migration trigger also covers inserts that omit handle during the data phase; explicit
-- handles already allocated by the application do not consume another number.
CREATE FUNCTION owner_handle_cutover_allocate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE next_number integer;
BEGIN
  IF NOT NEW.is_no_work AND NEW.handle IS NULL THEN
    INSERT INTO project_handle_counters (project_id, kind, n)
      VALUES (NEW.project_id, 'work', 1)
      ON CONFLICT (project_id, kind) DO UPDATE SET n = project_handle_counters.n + 1
      RETURNING n INTO next_number;
    NEW.handle := 'w' || next_number;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER owner_handle_cutover_allocate BEFORE INSERT OR UPDATE ON works
  FOR EACH ROW EXECUTE FUNCTION owner_handle_cutover_allocate();
--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_no_work_slug";
--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_slug_valid";
--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_no_work_handle" CHECK (("works"."is_no_work" AND "works"."handle" IS NULL) OR (NOT "works"."is_no_work" AND "works"."handle" IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_handle_valid" CHECK ("works"."handle" IS NULL OR "works"."handle" ~ '^w[1-9][0-9]*$') NOT VALID;
