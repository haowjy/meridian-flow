ALTER TABLE "document_drafts" DROP CONSTRAINT "document_drafts_seed_record_shape";--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_seed_record_shape" CHECK (("document_drafts"."seed_origins" IS NULL AND "document_drafts"."seed_live_room" IS NULL) OR ("document_drafts"."kind" = 'work_draft' AND "document_drafts"."seed_origins" IS NOT NULL AND "document_drafts"."seed_live_room" IS NOT NULL)) NOT VALID;--> statement-breakpoint
ALTER TABLE "document_drafts" VALIDATE CONSTRAINT "document_drafts_seed_record_shape";--> statement-breakpoint
ALTER TABLE "document_drafts" DROP COLUMN "seed_live_snapshot";--> statement-breakpoint
ALTER TABLE "document_drafts" DROP COLUMN "seed_draft_snapshot";
