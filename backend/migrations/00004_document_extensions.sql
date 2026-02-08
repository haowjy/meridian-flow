-- +goose Up
-- +goose ENVSUB ON

-- Document Extensions: Add extension column for file type support
-- Enables future multi-format support (markdown in DB, binaries in S3)
-- Extension stored separately from name for SOLID compliance (SRP)

-- Add extension column with default for existing documents
-- All existing documents default to .md (markdown)
ALTER TABLE ${TABLE_PREFIX}documents
ADD COLUMN IF NOT EXISTS extension TEXT NOT NULL DEFAULT '.md';

-- Add metadata JSONB column for format-specific stats
-- Structure: { "markdown": { "wordCount": N } } or { "image": { "width": W, "height": H } }
ALTER TABLE ${TABLE_PREFIX}documents
ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- Migrate existing word_count into metadata.markdown.wordCount
UPDATE ${TABLE_PREFIX}documents
SET metadata = jsonb_build_object('markdown', jsonb_build_object('wordCount', word_count))
WHERE word_count IS NOT NULL AND word_count > 0;

-- Drop word_count column (now stored in metadata.markdown.wordCount)
ALTER TABLE ${TABLE_PREFIX}documents
DROP COLUMN IF EXISTS word_count;

-- Drop the old uniqueness constraint (project_id, folder_id, name)
-- Note: Constraint name from initial schema
ALTER TABLE ${TABLE_PREFIX}documents
DROP CONSTRAINT IF EXISTS documents_project_id_folder_id_name_key;

-- Also handle the prefixed constraint name (for test/dev environments)
ALTER TABLE ${TABLE_PREFIX}documents
DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}documents_project_id_folder_id_name_key;

-- Add new uniqueness constraint including extension
-- Allows: "Chapter 5.md" + "Chapter 5.excalidraw" in same folder
ALTER TABLE ${TABLE_PREFIX}documents
ADD CONSTRAINT ${TABLE_PREFIX}documents_project_id_folder_id_name_extension_key
UNIQUE(project_id, folder_id, name, extension);

-- Update partial index for root-level uniqueness (folder_id IS NULL)
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}documents_root_unique;
CREATE UNIQUE INDEX idx_${TABLE_PREFIX}documents_root_unique
ON ${TABLE_PREFIX}documents(project_id, name, extension)
WHERE folder_id IS NULL AND deleted_at IS NULL;

-- Remove the default after migration
-- Future documents must explicitly specify extension
ALTER TABLE ${TABLE_PREFIX}documents
ALTER COLUMN extension DROP DEFAULT;

-- +goose Down
-- Restore extension default before removing (for documents created without it)
ALTER TABLE ${TABLE_PREFIX}documents
ALTER COLUMN extension SET DEFAULT '.md';

-- Restore original root-level uniqueness index
DROP INDEX IF EXISTS idx_${TABLE_PREFIX}documents_root_unique;
CREATE UNIQUE INDEX idx_${TABLE_PREFIX}documents_root_unique
ON ${TABLE_PREFIX}documents(project_id, name)
WHERE folder_id IS NULL AND deleted_at IS NULL;

-- Drop new constraint
ALTER TABLE ${TABLE_PREFIX}documents
DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}documents_project_id_folder_id_name_extension_key;

-- Restore old constraint (without extension)
ALTER TABLE ${TABLE_PREFIX}documents
ADD CONSTRAINT ${TABLE_PREFIX}documents_project_id_folder_id_name_key
UNIQUE(project_id, folder_id, name);

-- Restore word_count column
ALTER TABLE ${TABLE_PREFIX}documents
ADD COLUMN IF NOT EXISTS word_count INT NOT NULL DEFAULT 0;

-- Migrate metadata.markdown.wordCount back to word_count
UPDATE ${TABLE_PREFIX}documents
SET word_count = COALESCE((metadata->'markdown'->>'wordCount')::INT, 0)
WHERE metadata->'markdown'->>'wordCount' IS NOT NULL;

-- Drop metadata column
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS metadata;

-- Drop extension column
ALTER TABLE ${TABLE_PREFIX}documents DROP COLUMN IF EXISTS extension;
