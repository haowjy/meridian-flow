-- #888: owners are named by handle. Every Work gets a permanent `w<n>` and addresses carry it instead of the
-- Work's slug. Handle counters move to one table keyed by project and kind (`thread` is shared by chats and
-- subagents, `work` is new). No address string stored in documents, links or history is rewritten: the
-- database is reset at cutover, so none outlives it. 0063 builds the unique index, validates the checks and
-- retires the slug column and the old counter table.
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
ALTER TABLE "project_handle_counters" ADD CONSTRAINT "project_handle_counters_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action; -- migration-lint: skip ADD_FOREIGN_KEY_NOT_VALID (the table is created empty one statement above)
--> statement-breakpoint
ALTER TABLE "works" ADD COLUMN "handle" text;
--> statement-breakpoint
-- Backfill by creation order per project as if rows existed. Deleted Works count too: a handle is never reused.
-- No Work keeps a null handle.
UPDATE "works" SET "handle" = 'w' || "numbered"."n"
FROM (
  SELECT "id", row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id") AS "n"
  FROM "works" WHERE NOT "is_no_work"
) AS "numbered"
WHERE "works"."id" = "numbered"."id";
--> statement-breakpoint
-- The thread counter carries over unchanged, so no existing `c12` or `p3` changes.
INSERT INTO "project_handle_counters" ("project_id", "kind", "n")
SELECT "project_id", 'thread', "n" FROM "project_thread_counters";
--> statement-breakpoint
-- The next Work handle follows the highest minted one.
INSERT INTO "project_handle_counters" ("project_id", "kind", "n")
SELECT "project_id", 'work', count(*)::integer FROM "works" WHERE NOT "is_no_work" GROUP BY "project_id";
--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_no_work_slug";
--> statement-breakpoint
ALTER TABLE "works" DROP CONSTRAINT "works_slug_valid";
--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_no_work_handle" CHECK (("works"."is_no_work" AND "works"."handle" IS NULL) OR (NOT "works"."is_no_work" AND "works"."handle" IS NOT NULL)) NOT VALID;
--> statement-breakpoint
ALTER TABLE "works" ADD CONSTRAINT "works_handle_valid" CHECK ("works"."handle" IS NULL OR "works"."handle" ~ '^w[1-9][0-9]*$') NOT VALID;
