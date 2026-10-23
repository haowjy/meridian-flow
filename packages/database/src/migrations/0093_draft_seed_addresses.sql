SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_drafts" ADD COLUMN "seed_origins" jsonb;--> statement-breakpoint
ALTER TABLE "document_drafts" ADD COLUMN "seed_live_room" text;--> statement-breakpoint
ALTER TABLE "document_drafts" ADD COLUMN "seed_live_snapshot" "bytea";--> statement-breakpoint
ALTER TABLE "document_drafts" ADD COLUMN "seed_draft_snapshot" "bytea";--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_seed_record_shape" CHECK (("document_drafts"."seed_origins" IS NULL AND "document_drafts"."seed_live_room" IS NULL AND "document_drafts"."seed_live_snapshot" IS NULL AND "document_drafts"."seed_draft_snapshot" IS NULL) OR ("document_drafts"."kind" = 'work_draft' AND "document_drafts"."seed_origins" IS NOT NULL AND "document_drafts"."seed_live_room" IS NOT NULL AND "document_drafts"."seed_live_snapshot" IS NOT NULL AND "document_drafts"."seed_draft_snapshot" IS NOT NULL)) NOT VALID;