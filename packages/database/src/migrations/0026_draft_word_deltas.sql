ALTER TABLE "document_yjs_drafts" ADD COLUMN IF NOT EXISTS "words_added" integer;--> statement-breakpoint
ALTER TABLE "document_yjs_drafts" ADD COLUMN IF NOT EXISTS "words_removed" integer;
