-- +goose Up
-- +goose ENVSUB ON

ALTER TABLE ${TABLE_PREFIX}folders
    ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS autoapply BOOLEAN,
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE ${TABLE_PREFIX}folders
SET is_system = true
WHERE parent_id IS NULL
  AND name IN ('.meridian', '.agents')
  AND deleted_at IS NULL;

ALTER TABLE ${TABLE_PREFIX}documents
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS autoapply BOOLEAN,
    ADD COLUMN IF NOT EXISTS file_type TEXT NOT NULL DEFAULT 'markdown',
    ADD COLUMN IF NOT EXISTS storage_url TEXT,
    ADD COLUMN IF NOT EXISTS mime_type TEXT,
    ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

UPDATE ${TABLE_PREFIX}documents
SET file_type = CASE
    WHEN extension IN ('.md', '.markdown', '.txt') THEN 'markdown'
    WHEN extension = '.excalidraw' THEN 'excalidraw'
    WHEN extension IN ('.mmd', '.mermaid') THEN 'mermaid'
    ELSE 'markdown'
END
WHERE extension NOT IN ('.md', '.markdown', '.txt');

ALTER TABLE ${TABLE_PREFIX}documents
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}documents_file_type_check,
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}documents_size_bytes_check;

ALTER TABLE ${TABLE_PREFIX}documents
    ADD CONSTRAINT ${TABLE_PREFIX}documents_file_type_check
        CHECK (file_type IN ('markdown', 'skill', 'agent', 'tool', 'excalidraw', 'mermaid', 'image', 'pdf')),
    ADD CONSTRAINT ${TABLE_PREFIX}documents_size_bytes_check
        CHECK (size_bytes IS NULL OR size_bytes >= 0);

ALTER TABLE ${TABLE_PREFIX}projects
    ADD COLUMN IF NOT EXISTS autoapply BOOLEAN NOT NULL DEFAULT true;

INSERT INTO ${TABLE_PREFIX}folders (
    id,
    project_id,
    parent_id,
    name,
    is_hidden,
    is_system,
    description,
    autoapply,
    metadata,
    created_at,
    updated_at
)
SELECT
    uuid_generate_v4(),
    p.id,
    NULL,
    '.meridian',
    true,
    true,
    NULL,
    NULL,
    '{}'::jsonb,
    NOW(),
    NOW()
FROM ${TABLE_PREFIX}projects p
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM ${TABLE_PREFIX}folders f
      WHERE f.project_id = p.id
        AND f.parent_id IS NULL
        AND f.name = '.meridian'
        AND f.deleted_at IS NULL
  );

UPDATE ${TABLE_PREFIX}folders
SET is_system = true,
    is_hidden = true,
    autoapply = NULL
WHERE parent_id IS NULL
  AND name = '.meridian'
  AND deleted_at IS NULL
  AND (is_system = false OR autoapply IS NOT NULL);

INSERT INTO ${TABLE_PREFIX}folders (
    id,
    project_id,
    parent_id,
    name,
    is_hidden,
    is_system,
    description,
    autoapply,
    metadata,
    created_at,
    updated_at
)
SELECT
    uuid_generate_v4(),
    p.id,
    NULL,
    '.agents',
    true,
    true,
    NULL,
    false,
    '{}'::jsonb,
    NOW(),
    NOW()
FROM ${TABLE_PREFIX}projects p
WHERE p.deleted_at IS NULL
  AND NOT EXISTS (
      SELECT 1
      FROM ${TABLE_PREFIX}folders f
      WHERE f.project_id = p.id
        AND f.parent_id IS NULL
        AND f.name = '.agents'
        AND f.deleted_at IS NULL
  );

UPDATE ${TABLE_PREFIX}folders
SET is_system = true,
    is_hidden = true,
    autoapply = false
WHERE parent_id IS NULL
  AND name = '.agents'
  AND deleted_at IS NULL
  AND (is_system = false OR autoapply IS DISTINCT FROM false);

-- +goose Down
-- +goose ENVSUB ON

DELETE FROM ${TABLE_PREFIX}folders WHERE is_system = true;

ALTER TABLE ${TABLE_PREFIX}projects
    DROP COLUMN IF EXISTS autoapply;

ALTER TABLE ${TABLE_PREFIX}documents
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}documents_file_type_check,
    DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}documents_size_bytes_check;

ALTER TABLE ${TABLE_PREFIX}documents
    DROP COLUMN IF EXISTS description,
    DROP COLUMN IF EXISTS autoapply,
    DROP COLUMN IF EXISTS file_type,
    DROP COLUMN IF EXISTS storage_url,
    DROP COLUMN IF EXISTS mime_type,
    DROP COLUMN IF EXISTS size_bytes;

ALTER TABLE ${TABLE_PREFIX}folders
    DROP COLUMN IF EXISTS is_system,
    DROP COLUMN IF EXISTS description,
    DROP COLUMN IF EXISTS autoapply,
    DROP COLUMN IF EXISTS metadata;
