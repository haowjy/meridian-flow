-- B1b: the undo/redo action id and consume list lose their readers and writers; the historical `kind`
-- values stay as written (no B4). The index over action_id went in 0052, so each drop is metadata-only.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_edits" DROP COLUMN "action_id";--> statement-breakpoint
ALTER TABLE "document_edits" DROP COLUMN "consumes";
