ALTER TABLE "document_branches" ALTER COLUMN "schema_version" SET DEFAULT 5000;--> statement-breakpoint
ALTER TABLE "document_yjs_heads" ALTER COLUMN "schema_version" SET DEFAULT 5000;--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "slug" text;--> statement-breakpoint
DO $$
DECLARE
  work_row record;
  base_slug text;
  candidate_slug text;
  suffix integer;
BEGIN
  FOR work_row IN
    SELECT id, project_id, name
    FROM works
    ORDER BY project_id, created_at, id
  LOOP
    base_slug := trim(BOTH '-' FROM regexp_replace(lower(work_row.name), '[^a-z0-9]+', '-', 'g'));
    IF base_slug = '' THEN
      base_slug := 'work';
    END IF;

    candidate_slug := base_slug;
    suffix := 2;
    WHILE EXISTS (
      SELECT 1 FROM works
      WHERE project_id = work_row.project_id AND slug = candidate_slug
    ) LOOP
      candidate_slug := base_slug || '-' || suffix;
      suffix := suffix + 1;
    END LOOP;

    UPDATE works SET slug = candidate_slug WHERE id = work_row.id;
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "works" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "works_project_slug_active" ON "works" USING btree ("project_id","slug") WHERE "works"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_slug_valid" CHECK ("works"."slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');
