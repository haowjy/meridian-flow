-- +goose Up
-- +goose ENVSUB ON

-- Skills: remove legacy display_name column.
-- Skills are identified and displayed by `name` only.
ALTER TABLE ${TABLE_PREFIX}project_skills
DROP COLUMN IF EXISTS display_name;

-- +goose Down
-- +goose ENVSUB ON

-- Restore legacy display_name column for backward compatibility.
ALTER TABLE ${TABLE_PREFIX}project_skills
ADD COLUMN IF NOT EXISTS display_name TEXT;

UPDATE ${TABLE_PREFIX}project_skills
SET display_name = name
WHERE display_name IS NULL;

ALTER TABLE ${TABLE_PREFIX}project_skills
ALTER COLUMN display_name SET NOT NULL;
