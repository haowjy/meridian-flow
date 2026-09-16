CREATE TABLE "project_thread_counters" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"n" integer NOT NULL
);
--> statement-breakpoint
DROP INDEX "threads_project_slug";--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "ref" text;--> statement-breakpoint
UPDATE "threads" AS t
SET "ref" = 'c' || s.n::text
FROM (
	SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY created_at ASC, id ASC) AS n
	FROM "threads"
	WHERE kind = 'primary'
) AS s
WHERE t.id = s.id;--> statement-breakpoint
INSERT INTO "project_thread_counters" ("project_id", "n")
SELECT project_id, COUNT(*)::int
FROM "threads"
WHERE kind = 'primary'
GROUP BY project_id;--> statement-breakpoint
ALTER TABLE "project_thread_counters" ADD CONSTRAINT "project_thread_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (pre-release empty table)--> statement-breakpoint
CREATE UNIQUE INDEX "threads_project_ref" ON "threads" USING btree ("project_id","ref") WHERE "threads"."ref" IS NOT NULL; -- migration-lint: skip INDEX_NOT_CONCURRENTLY (pre-release schema; no production users or data)--> statement-breakpoint
ALTER TABLE "threads" DROP COLUMN "slug"; -- migration-lint: skip DROP_COLUMN (pre-release; word slugs are replaced by ref, no users)
