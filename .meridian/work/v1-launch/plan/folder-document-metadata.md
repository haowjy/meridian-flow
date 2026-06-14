# Folder & Document Metadata Migration

## Summary

Add first-class metadata to folders and documents. Add `is_system` column (replacing `is_hidden`). Bootstrap system folders on project creation. Add explicit `file_type` column to documents. Add nullable columns for future blob storage.

## Review Findings Applied

Design updated after 3x GPT 5.4 review (spawns p117-p119):

1. **No column rename** — add `is_system` alongside `is_hidden`, backfill, dual-read during transition. Drop `is_hidden` in a later cleanup migration.
2. **Transactional bootstrap** — system folder creation inside project creation transaction, using privileged path that bypasses reserved-name validation.
3. **Project-level autoapply default** — add `autoapply` column to projects table as the terminal root.
4. **System folders override document-level autoapply** — in system folders (`is_system=true`), the folder's `autoapply` wins regardless of document-level overrides.
5. **file_type as additive** — populated from extension, both coexist during transition. Service still uses extension for now. Add CHECK constraint for allowed values.
6. **Keep EnsureMeridianSubfolder temporarily** — skill creation still needs it until A3 migration. Mark as deprecated, remove after A3.
7. **Immutability guards** — add rename/move/delete blocks for `is_system=true` folders in folder service.

## Schema Changes

### Projects

```sql
ALTER TABLE ${TABLE_PREFIX}projects ADD COLUMN autoapply boolean NOT NULL DEFAULT true;
```

- `autoapply` — project-level default. Terminal root of the inheritance chain. Default `true` (auto-apply AI changes). User can change per-project.

### Folders

```sql
-- Add new column (keep is_hidden during transition)
ALTER TABLE ${TABLE_PREFIX}folders ADD COLUMN is_system boolean NOT NULL DEFAULT false;
ALTER TABLE ${TABLE_PREFIX}folders ADD COLUMN description text;
ALTER TABLE ${TABLE_PREFIX}folders ADD COLUMN autoapply boolean;
ALTER TABLE ${TABLE_PREFIX}folders ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';

-- Backfill: system = hidden
UPDATE ${TABLE_PREFIX}folders SET is_system = is_hidden;

-- is_hidden stays for now, removed in a later cleanup migration
```

- `is_system` — can't be renamed, moved, or deleted. Filtered from default explorer tree. Overrides document-level autoapply (folder wins).
- `description` — free text, searchable, future vectorization.
- `autoapply` — nullable boolean. `null` = inherit from parent, `true` = auto-apply, `false` = require review.
- `metadata` — extensible jsonb for tags, import context, future properties.

### Documents

```sql
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN description text;
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN autoapply boolean;
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN file_type text NOT NULL DEFAULT 'markdown';
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN storage_url text;
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN mime_type text;
ALTER TABLE ${TABLE_PREFIX}documents ADD COLUMN size_bytes bigint;

-- Backfill file_type from extension
UPDATE ${TABLE_PREFIX}documents SET file_type = CASE
    WHEN extension IN ('.md', '.markdown', '.txt') THEN 'markdown'
    WHEN extension = '.excalidraw' THEN 'excalidraw'
    WHEN extension IN ('.mmd', '.mermaid') THEN 'mermaid'
    ELSE 'markdown'
END;

-- Constrain allowed values
ALTER TABLE ${TABLE_PREFIX}documents ADD CONSTRAINT ${TABLE_PREFIX}documents_file_type_check
    CHECK (file_type IN ('markdown', 'skill', 'agent', 'tool', 'excalidraw', 'mermaid', 'image', 'pdf'));

-- Non-negative size
ALTER TABLE ${TABLE_PREFIX}documents ADD CONSTRAINT ${TABLE_PREFIX}documents_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes >= 0);
```

- `description` — free text, searchable, future vectorization.
- `autoapply` — nullable boolean. `null` = inherit from parent folder. In system folders, document-level overrides are ignored.
- `file_type` — explicit discriminator. Populated from extension during transition. Service still reads extension for now.
- `storage_url` — nullable placeholder for future blob storage.
- `mime_type` — nullable placeholder.
- `size_bytes` — nullable placeholder with non-negative constraint.

### Autoapply Inheritance

Resolution walks up the tree until a non-null value is found:

```
document.autoapply → folder.autoapply → parent_folder.autoapply → ... → project.autoapply
```

**Exception:** In `is_system=true` folders, the folder's `autoapply` value is authoritative — document-level overrides are ignored. This prevents an agent from setting `autoapply=true` on a skill file to bypass `.agents/` review gating.

- `.agents/` folder: `autoapply = false` — agent writes to skills always require user review.
- `.meridian/` folder: `autoapply = null` — inherits project default.
- User folders: `autoapply = null` — inherits project default.
- Project default: `autoapply = true` — AI changes auto-apply by default.

## Project Bootstrap

On project creation, within the same transaction:

```go
func (s *projectService) CreateProject(ctx, userID, req) (*Project, error) {
    tx := beginTransaction()
    project := createProject(tx, req)

    // Privileged path — bypasses reserved-name validation
    createSystemFolder(tx, project.ID, ".meridian", autoapply: nil)
    createSystemFolder(tx, project.ID, ".agents",   autoapply: false)

    tx.Commit()
    return project, nil
}
```

- `createSystemFolder` is a new privileged repo method that sets `is_system=true`, `is_hidden=true` (during transition), and bypasses the reserved-name check in normal folder creation.
- Existing projects need a backfill migration that creates missing system folders.

### EnsureMeridianFolder — deprecation path

Keep `EnsureMeridianFolder` and `EnsureMeridianSubfolder` for now. Skill creation (`project_skill.go`) still calls `EnsureMeridianSubfolder("skills")`. Mark as deprecated. Remove after A3 migration (when skills move to `.agents/skills/`).

## Go Model Changes

### Folder model (`domain/models/docsystem/folder.go`)

- Add `IsSystem bool` field with db tag `is_system`
- Keep `IsHidden bool` during transition (both fields populated from same source)
- Add `Description *string`, `Autoapply *bool`, `Metadata map[string]interface{}`

### Document model (`domain/models/docsystem/document.go`)

- Add `Description *string`, `Autoapply *bool`
- Add `FileType string` (with constants: `FileTypeMarkdown`, `FileTypeSkill`, `FileTypeAgent`, `FileTypeTool`, `FileTypeExcalidraw`, `FileTypeMermaid`, `FileTypeImage`, `FileTypePDF`)
- Add `StorageURL *string`, `MimeType *string`, `SizeBytes *int64`
- Keep `Extension` column — used for display and still the primary discriminator during transition
- Keep `FileTypeFromExtension()` during transition — `file_type` column populated but service still reads extension

### Tree models (`domain/services/docsystem/tree_models.go`)

- Add `TreeFolder.IsSystem` (alongside existing `IsHidden` during transition)
- Add `TreeFolder.Description`, `TreeFolder.Autoapply`, `TreeFolder.Metadata`
- Add `TreeDocument.FileType`, `TreeDocument.Description`
- Tree filtering: use `is_system` for filtering (falls back to `is_hidden` during transition)

### Folder service — immutability guards

Add to folder update/delete/move flows:

```go
func (s *folderService) UpdateFolder(ctx, userID, folderID, req) error {
    folder := s.repo.Get(ctx, folderID)
    if folder.IsSystem {
        return domain.ErrForbidden("cannot modify system folder")
    }
    // ... existing logic
}
```

Same guard on `DeleteFolder` and `MoveFolder`.

## Repository Changes

All document CRUD queries must include new columns in SELECT/INSERT/UPDATE:
- `description`, `autoapply`, `file_type`, `storage_url`, `mime_type`, `size_bytes`

All folder CRUD queries must include:
- `is_system`, `description`, `autoapply`, `metadata`

Scan lists in repository methods must be updated to match.

**Estimated scope: ~30 files** (mid-20s backend, 5-8 frontend/API DTOs, tests).

## Folder Metadata Examples

```json
// System folder (no extra metadata needed)
{}

// EPUB import folder (future)
{"imported_from": "epub", "original_filename": "my-novel.epub"}

// User folder with tags
{"tags": ["arc-2", "draft"]}
```

## What This Does NOT Include

- Blob storage implementation (columns are nullable placeholders)
- Autoapply enforcement logic (just the schema + inheritance model)
- EPUB import (just the folder metadata shape)
- Removing the `extension` column (kept for backward compat + display)
- Removing `is_hidden` column (separate cleanup migration after transition)
- Removing `.session` namespace (separate cleanup)
- Removing `EnsureMeridianFolder` (after A3 migration)
- Frontend `file_type` integration (frontend still derives from extension)
