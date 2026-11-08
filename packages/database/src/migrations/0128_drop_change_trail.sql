-- Deletes the change-trail program. Five triggers on live tables fed change_trail_dirty_log
-- through two functions, so triggers and functions go first: the functions are plpgsql and bind
-- tables late, so dropping the tables first would fail every insert into turns or document_edits.
-- Old turn.change_trail_* rows stay in event_journal: deleting them would punch holes in seq.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
DROP TRIGGER capture_change_trail_turn ON turns;
--> statement-breakpoint
DROP TRIGGER capture_change_trail_receipt ON document_edits;
--> statement-breakpoint
DROP TRIGGER capture_change_trail_part ON document_edit_parts;
--> statement-breakpoint
DROP TRIGGER capture_change_trail_journal ON draft_write_journal;
--> statement-breakpoint
DROP TRIGGER capture_change_trail_publication ON push_lineage;
--> statement-breakpoint
DROP FUNCTION capture_change_trail_signal();
--> statement-breakpoint
DROP FUNCTION change_trail_owners(uuid[], bigint[], bigint[], uuid, uuid);
--> statement-breakpoint
DROP TABLE "change_trail_document_details";
--> statement-breakpoint
DROP TABLE "change_trail_document_occurrences";
--> statement-breakpoint
DROP TABLE "change_trail_delivery_outbox";
--> statement-breakpoint
DROP TABLE "change_trail_shells";
--> statement-breakpoint
DROP TABLE "change_trail_dirty_log";
