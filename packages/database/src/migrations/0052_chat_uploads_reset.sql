-- #875 P6: a chat owns its uploads, so every Work-owned and No Work upload is deleted (the owner ruled a reset
-- instead of a move; a one-off exception to the rule that migrations preserve data). Message attachments that
-- pointed at them stay in history and read as unavailable. Object-store bytes are not touched here.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
-- Ahead refs for the old uploads go first: deleting the documents would only unsettle them.
DELETE FROM "link_ahead_refs" WHERE "scheme" = 'uploads' AND ("work_id" IS NOT NULL OR "root_thread_id" IS NULL);
--> statement-breakpoint
-- Documents, folders, previous locations, Yjs rows, edits and intakes of these sources go with them by FK cascade.
-- A document an upload was moved out of its source into another source is not deleted.
DELETE FROM "context_sources" WHERE "slug" = 'uploads' AND "scope" <> 'chat';
--> statement-breakpoint
DELETE FROM "upload_intakes" WHERE "owner_thread_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD COLUMN "chat_thread_id" uuid;
--> statement-breakpoint
-- P2 stored a chat owner in root_thread_id; lineage Scratch keeps it there, a chat's uploads move to the new column.
UPDATE "link_ahead_refs" SET "chat_thread_id" = "root_thread_id", "root_thread_id" = NULL WHERE "scheme" = 'uploads';
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP CONSTRAINT "upload_intakes_work_id_works_id_fk";
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP COLUMN "work_id";
--> statement-breakpoint
ALTER TABLE "upload_intakes" DROP COLUMN "canonical_uri";
--> statement-breakpoint
ALTER TABLE "upload_intakes" ADD CONSTRAINT "upload_intakes_owner_required" CHECK ("owner_thread_id" IS NOT NULL) NOT VALID;
--> statement-breakpoint
ALTER TABLE "context_sources" ADD CONSTRAINT "context_sources_uploads_chat_only" CHECK ("context_sources"."slug" <> 'uploads' OR "context_sources"."scope" = 'chat') NOT VALID;
