-- migration: no-transaction
-- Bound the projection full-text index to the first 150,000 characters: Postgres rejects a
-- tsvector over 1 MB, which aborts the transaction writing such a document. Build the bounded
-- index beside the old one, then retire the old. Every statement is re-runnable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "document_markdown_projections_fts_head" ON "document_markdown_projections" USING gin (to_tsvector('simple', left("markdown", 150000)));
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_markdown_projections_fts";
