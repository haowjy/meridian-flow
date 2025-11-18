-- +goose Up
-- +goose ENVSUB ON
-- Add full-text search indexes for documents
-- Supports multi-language search with PostgreSQL FTS on both name and content fields
-- Future-ready for vector search extension (pgvector)

-- Content field indexes
-- Language-agnostic GIN index using 'simple' dictionary
CREATE INDEX IF NOT EXISTS idx_documents_content_fts_simple
ON ${TABLE_PREFIX}documents
USING gin(to_tsvector('simple', content))
WHERE deleted_at IS NULL;

-- English-optimized GIN index with stemming and stop word removal
CREATE INDEX IF NOT EXISTS idx_documents_content_fts_english
ON ${TABLE_PREFIX}documents
USING gin(to_tsvector('english', content))
WHERE deleted_at IS NULL;

-- Name/title field indexes
-- Language-agnostic GIN index for document titles
CREATE INDEX IF NOT EXISTS idx_documents_name_fts_simple
ON ${TABLE_PREFIX}documents
USING gin(to_tsvector('simple', name))
WHERE deleted_at IS NULL;

-- English-optimized GIN index for document titles
CREATE INDEX IF NOT EXISTS idx_documents_name_fts_english
ON ${TABLE_PREFIX}documents
USING gin(to_tsvector('english', name))
WHERE deleted_at IS NULL;

-- +goose Down
-- Remove full-text search indexes
DROP INDEX IF EXISTS idx_documents_content_fts_simple;
DROP INDEX IF EXISTS idx_documents_content_fts_english;
DROP INDEX IF EXISTS idx_documents_name_fts_simple;
DROP INDEX IF EXISTS idx_documents_name_fts_english;
