ALTER TABLE "document_drafts" ADD COLUMN "successor_draft_id" text;
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_successor_draft_id_document_drafts_id_fk" FOREIGN KEY ("successor_draft_id") REFERENCES "public"."document_drafts"("id") ON DELETE set null ON UPDATE no action NOT VALID;
--> statement-breakpoint
ALTER TABLE "document_drafts" VALIDATE CONSTRAINT "document_drafts_successor_draft_id_document_drafts_id_fk";
