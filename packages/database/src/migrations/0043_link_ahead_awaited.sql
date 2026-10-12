SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "link_ahead_refs" ADD COLUMN "awaited_document_id" uuid;
