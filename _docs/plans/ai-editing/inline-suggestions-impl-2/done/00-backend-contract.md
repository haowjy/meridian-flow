# Phase 0: Backend Contract (Required)

## Goal

Support atomic, concurrency-safe updates for `ai_version` so the frontend can save `content` + `ai_version` in a single request without overwriting unseen AI updates.

## What You're Building

- `PATCH /api/documents/{id}` supports tri-state `ai_version` (absent/null/string)
- `documents.ai_version_rev` revision counter
- CAS precondition: `ai_version_base_rev` required whenever `ai_version` is present
- `409 Conflict` response includes the current document snapshot

## Steps

### 0.1: Tri-state semantics (required)

- **absent** → don’t change `ai_version`
- **null** → clear `ai_version` (set NULL)
- **string (including `\"\"`)** → set `ai_version` to that value

### 0.2: Add `ai_version_rev` (required)

Migration (example):

```sql
ALTER TABLE ${TABLE_PREFIX}documents
  ADD COLUMN IF NOT EXISTS ai_version_rev INTEGER NOT NULL DEFAULT 0;
```

Rules:
- Any time `ai_version` changes, increment `ai_version_rev`.

### 0.3: Add `ai_version_base_rev` precondition (required)

Extend PATCH to accept optional `ai_version_base_rev`:
- If request includes `ai_version` (present, including `null`), require `ai_version_base_rev`.
- Server checks current `ai_version_rev`:
  - match → apply `ai_version`, increment rev
  - mismatch → `409 Conflict` (do not apply `ai_version`)

**`409` response body structure (required):**

```json
{
  "error": "ai_version_conflict",
  "message": "Document ai_version was modified since last fetch",
  "current_ai_version_rev": 5,
  "document": {
    "id": "...",
    "content": "...",
    "ai_version": "...",
    "ai_version_rev": 5,
    "updated_at": "..."
  }
}
```

### 0.4: Handler DTO mapping (required)

> Note: tri-state `ai_version` decoding via `httputil.OptionalString` is already implemented (see `backend/internal/httputil/optional_string.go` and `backend/internal/handler/document.go`).

Update `backend/internal/domain/services/docsystem/document.go`:

```go
// OptionalAIVersion is transport-agnostic PATCH semantics for ai_version:
// - Present=false => no change
// - Present=true + Value=nil => clear
// - Present=true + Value=&"" or &"text" => set ("" is valid)
type OptionalAIVersion struct {
  Present bool
  Value   *string
}

type UpdateDocumentRequest struct {
  ProjectID  string                 `json:"project_id"`
  Name       *string                `json:"name,omitempty"`
  FolderPath *string                `json:"folder_path,omitempty"`
  FolderID   *string                `json:"folder_id,omitempty"`
  Content    *string                `json:"content,omitempty"`
  AIVersion  OptionalAIVersion      `json:"-"`
  // Only meaningful when AIVersion.Present == true.
  // Used for compare-and-swap against documents.ai_version_rev.
  AIVersionBaseRev int              `json:"-"`
}
```

Update `backend/internal/handler/document.go`:

```go
type updateDocumentPatchRequest struct {
  ProjectID  string                  `json:"project_id"`
  Name       *string                 `json:"name,omitempty"`
  FolderPath *string                 `json:"folder_path,omitempty"`
  FolderID   *string                 `json:"folder_id,omitempty"`
  Content    *string                 `json:"content,omitempty"`
  AIVersion  httputil.OptionalString `json:"ai_version"`
  AIVersionBaseRev *int              `json:"ai_version_base_rev,omitempty"`
}

// In handler UpdateDocument:
var dto updateDocumentPatchRequest
if err := httputil.ParseJSON(w, r, &dto); err != nil { ... }

req := docsysSvc.UpdateDocumentRequest{
  ProjectID:  dto.ProjectID,
  Name:       dto.Name,
  FolderPath: dto.FolderPath,
  FolderID:   dto.FolderID,
  Content:    dto.Content,
}

if dto.AIVersion.Present {
  if dto.AIVersionBaseRev == nil {
    // 400: cannot safely apply ai_version without concurrency token
  }

  if dto.AIVersion.IsNull {
    req.AIVersion = docsysSvc.OptionalAIVersion{Present: true, Value: nil}
  } else {
    v := dto.AIVersion.Value
    req.AIVersion = docsysSvc.OptionalAIVersion{Present: true, Value: &v}
  }

  req.AIVersionBaseRev = *dto.AIVersionBaseRev
}
```

### 0.5: Atomic repository update (required)

Update `backend/internal/service/docsystem/document.go` in `UpdateDocument(...)`:

```go
if req.AIVersion.Present {
  rowsAffected, err := repo.UpdateWithAIVersionCheck(ctx, tx, UpdateWithAIVersionParams{
    ID:               id,
    Content:          req.Content,
    Name:             req.Name,
    FolderID:         req.FolderID,
    AIVersion:        req.AIVersion.Value,  // nil = clear, &"" = empty, &"text" = set
    AIVersionBaseRev: req.AIVersionBaseRev,
  })
  if err != nil {
    return nil, err
  }
  if rowsAffected == 0 {
    return nil, ErrAIVersionConflict  // 409 Conflict
  }
} else {
  err := repo.Update(ctx, tx, id, req.Content, req.Name, req.FolderID)
  if err != nil {
    return nil, err
  }
}
```

Update `backend/internal/repository/postgres/docsystem/document.go`:

```go
// UpdateWithAIVersionCheck atomically updates content + ai_version with rev check.
// Returns (rowsAffected, error). rowsAffected == 0 means rev mismatch (conflict).
func (r *DocumentRepository) UpdateWithAIVersionCheck(
  ctx context.Context,
  tx *sql.Tx,
  params UpdateWithAIVersionParams,
) (int64, error) {
  // NOTE: COALESCE for content ensures that nil doesn't overwrite existing content.
  // This matters for partial updates where only ai_version changes (e.g. "Close AI").
  query := `
    UPDATE documents
    SET content = COALESCE($1, content),
        name = COALESCE($2, name),
        folder_id = COALESCE($3, folder_id),
        ai_version = $4,
        ai_version_rev = ai_version_rev + 1,
        updated_at = NOW()
    WHERE id = $5
      AND ai_version_rev = $6
  `
  result, err := tx.ExecContext(ctx, query,
    params.Content,
    params.Name,
    params.FolderID,
    params.AIVersion,
    params.ID,
    params.AIVersionBaseRev,
  )
  if err != nil {
    return 0, err
  }
  return result.RowsAffected()
}
```

## Verification Checklist

- [ ] `ai_version_rev` exists and increments on every `ai_version` change
- [ ] PATCH rejects stale `ai_version_base_rev` with `409` + document snapshot
- [ ] PATCH can update `ai_version` without requiring `content`

