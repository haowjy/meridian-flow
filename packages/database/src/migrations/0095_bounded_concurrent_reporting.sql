SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_drafts" DROP CONSTRAINT "document_drafts_seed_record_shape";--> statement-breakpoint
ALTER TABLE "observation_frontiers" ADD COLUMN "journal_position" bigint;--> statement-breakpoint
ALTER TABLE "document_drafts" ADD COLUMN "seed_live_state" "bytea";--> statement-breakpoint
ALTER TABLE "document_drafts" ADD COLUMN "seed_live_position" bigint;--> statement-breakpoint
ALTER TABLE "observation_frontiers" DROP COLUMN "unshown";--> statement-breakpoint
ALTER TABLE "document_drafts" ADD CONSTRAINT "document_drafts_seed_record_shape" CHECK ((("document_drafts"."seed_origins" IS NULL AND "document_drafts"."seed_live_room" IS NULL AND "document_drafts"."seed_live_snapshot" IS NULL AND "document_drafts"."seed_draft_snapshot" IS NULL) OR ("document_drafts"."kind" = 'work_draft' AND "document_drafts"."seed_origins" IS NOT NULL AND "document_drafts"."seed_live_room" IS NOT NULL AND "document_drafts"."seed_live_snapshot" IS NOT NULL AND "document_drafts"."seed_draft_snapshot" IS NOT NULL)) AND (("document_drafts"."seed_live_state" IS NULL AND "document_drafts"."seed_live_position" IS NULL) OR ("document_drafts"."seed_live_state" IS NOT NULL AND "document_drafts"."seed_live_position" IS NOT NULL))) NOT VALID;
