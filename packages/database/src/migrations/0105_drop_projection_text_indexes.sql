-- migration: no-transaction
DROP INDEX CONCURRENTLY IF EXISTS "document_markdown_projections_fts";
--> statement-breakpoint
DROP INDEX CONCURRENTLY IF EXISTS "document_markdown_projections_trgm";
