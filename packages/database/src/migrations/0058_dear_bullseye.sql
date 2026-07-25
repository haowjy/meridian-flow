ALTER TABLE "change_trail_document_details" ADD COLUMN "words_added" integer;--> statement-breakpoint
ALTER TABLE "change_trail_document_details" ADD COLUMN "words_removed" integer;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD COLUMN "documents" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "change_trail_shells" AS shell
SET "documents" = details.documents
FROM (
  SELECT "trail_id", jsonb_agg(
    jsonb_build_object('documentId', "document_id", 'title', "document_title")
    ORDER BY "document_id"
  ) AS documents
  FROM "change_trail_document_details"
  GROUP BY "trail_id"
) AS details
WHERE shell."id" = details."trail_id";--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD COLUMN "words_added" integer;--> statement-breakpoint
ALTER TABLE "change_trail_shells" ADD COLUMN "words_removed" integer;
