# Backend API for AI Editing

**PATCH semantics, tri-state aiVersion, and CAS concurrency control.**

---

## Document Model

```go
type Document struct {
    // ... existing fields ...
    AIVersion    *string  // AI-suggested version (nullable)
    AIVersionRev int      // Revision counter for CAS
}
```

---

## PATCH /api/documents/{id}

### Tri-State Semantics (RFC 7396)

| JSON Value | Go Value | Meaning |
|------------|----------|---------|
| Field omitted | `nil` (not present) | Don't change aiVersion |
| `"ai_version": null` | `*string = nil` (present, null) | Clear aiVersion |
| `"ai_version": ""` | `*string = ""` | Set to empty string |
| `"ai_version": "text"` | `*string = "text"` | Set to text |

**Implementation**: Uses `OptionalField[T]` wrapper to distinguish absent vs null.

### CAS Token

When PATCH includes `ai_version`, it **must** include `ai_version_base_rev`:

```json
{
  "content": "updated text...",
  "ai_version": "AI suggested text...",
  "ai_version_base_rev": 5
}
```

**Server validation:**
1. If `ai_version_base_rev` != current `ai_version_rev` -> **409 Conflict**
2. If match -> update `ai_version`, increment `ai_version_rev`

---

## Conflict Response (409)

```json
{
  "error": "ai_version_conflict",
  "message": "AI version has been updated since you last loaded",
  "document": {
    "id": "...",
    "content": "...",
    "ai_version": "...",
    "ai_version_rev": 6
  }
}
```

Frontend uses the returned document to refresh the editor.

---

## Lightweight Status Endpoint

`GET /api/documents/{id}/ai-status`

Returns only AI version metadata (~100 bytes vs ~50KB full doc):

```json
{
  "ai_version_rev": 6,
  "has_ai_version": true
}
```

Used for polling to detect background AI updates without fetching full content.

---

## Save Scenarios

| Editor State | PATCH Fields | Purpose |
|--------------|--------------|---------|
| No markers, server closed | `content` only | Normal save |
| No markers, server has aiVersion | `content`, `ai_version: null`, `ai_version_base_rev` | Close AI session |
| Has markers | `content`, `ai_version`, `ai_version_base_rev` | Update both |

---

## Related

- `backend/internal/handler/document.go:UpdateDocument` - PATCH handler
- `backend/internal/domain/models/docsystem/document.go` - Model definition
- [architecture.md](architecture.md) - Overall data flow
