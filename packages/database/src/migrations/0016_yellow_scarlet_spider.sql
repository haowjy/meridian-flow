ALTER TABLE "document_yjs_drafts" DROP CONSTRAINT "document_yjs_drafts_thread_id_threads_id_fk";
--> statement-breakpoint
DROP INDEX "document_yjs_drafts_active_document_thread";--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD COLUMN "work_id" uuid;
--> statement-breakpoint
UPDATE "document_yjs_drafts" AS "draft"
SET "work_id" = "membership"."work_id"
FROM "thread_works" AS "membership"
WHERE "draft"."thread_id" = "membership"."thread_id"
  AND "membership"."is_primary" = true;
--> statement-breakpoint
DELETE FROM "document_yjs_drafts"
WHERE "work_id" IS NULL;
--> statement-breakpoint
DELETE FROM "document_yjs_drafts" AS "draft"
USING (
  SELECT "id"
  FROM (
    SELECT
      "id",
      row_number() OVER (
        PARTITION BY "document_id", "work_id"
        ORDER BY "updated_at" DESC, "id" ASC
      ) AS "rank"
    FROM "document_yjs_drafts"
    WHERE "status" IN ('active', 'accepting')
  ) AS "ranked_open_drafts"
  WHERE "rank" > 1
) AS "duplicate_open_drafts"
WHERE "draft"."id" = "duplicate_open_drafts"."id";
--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" DROP COLUMN "thread_id";
--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ALTER COLUMN "work_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD CONSTRAINT "document_yjs_drafts_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "public"."works"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_yjs_drafts_active_document_work" ON "document_yjs_drafts" USING btree ("document_id","work_id") WHERE status IN ('active', 'accepting');
