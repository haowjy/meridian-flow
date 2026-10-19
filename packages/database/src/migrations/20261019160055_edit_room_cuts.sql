-- Nullable receipt metadata adds no table rewrite; bound DDL lock acquisition.
SET LOCAL lock_timeout = '2s';
--> statement-breakpoint
ALTER TABLE "document_edits" ADD COLUMN "source_room" text;--> statement-breakpoint
ALTER TABLE "document_edits" ADD COLUMN "before_cut" "bytea";--> statement-breakpoint
ALTER TABLE "document_edits" ADD COLUMN "after_cut" "bytea";--> statement-breakpoint
ALTER TABLE "document_edits" ADD CONSTRAINT "document_edits_cuts_presence" CHECK (("document_edits"."source_room" IS NULL AND "document_edits"."before_cut" IS NULL AND "document_edits"."after_cut" IS NULL) OR ("document_edits"."source_room" IS NOT NULL AND "document_edits"."before_cut" IS NOT NULL AND "document_edits"."after_cut" IS NOT NULL)) NOT VALID;
