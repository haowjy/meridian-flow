-- migration: no-transaction
-- Keep human typing history out of draft AI receipt reads. Re-runnable online indexes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edit_parts_edit_origin_draft_idx" ON "document_edit_parts" USING btree ("edit_id",("origin"->>'draftId'));--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_edits_agent_document_idx" ON "document_edits" USING btree ("document_id","id") WHERE "document_edits"."actor" = 'agent';
