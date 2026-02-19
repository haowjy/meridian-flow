---
stack: both
status: complete
feature: "File Types & Extensions"
---

# File Types & Extensions

**Multi-format document support with extension-based metadata.**

---

## Supported Extensions

| Extension | FileType | Editor | Metadata | Notes |
|-----------|----------|--------|----------|-------|
| `.md` | markdown | CodeMirror | `markdown.wordCount` | Primary format |
| `.markdown` | markdown | CodeMirror | `markdown.wordCount` | Alias |
| `.txt` | markdown | CodeMirror | `markdown.wordCount` | Treated as markdown |
| `.excalidraw` | excalidraw | Excalidraw | (future) | JSON-based diagrams |
| `.mmd`, `.mermaid` | mermaid | Mermaid | (future) | Diagram markup |

---

## Metadata Structure

Format-specific stats stored in `metadata` JSONB column. Each file type category gets its own namespace.

### Markdown Family

```json
{ "markdown": { "wordCount": 1500 } }
```

Word count is computed on create/update for markdown-family files only.

### Future Formats

```json
// Images (planned)
{ "image": { "width": 1920, "height": 1080 } }

// Diagrams (planned)
{ "diagram": { "nodeCount": 15 } }
```

---

## Extension Handling

### Normalization Rules

- **Lowercase**: Extensions are normalized to lowercase (`MD` -> `.md`)
- **Leading dot**: Ensured automatically (`md` -> `.md`)
- **Empty default**: Empty extension defaults to `.md`
- **Validation**: Invalid extensions rejected with HTTP 400

### Uniqueness

Documents are unique by `(project_id, folder_id, name, extension)`:

```
✅ Allowed in same folder:
- "Chapter 1.md"
- "Chapter 1.excalidraw"

❌ Not allowed (conflict):
- "Chapter 1.md"
- "Chapter 1.md"
```

---

## Implementation Files

| Layer | File |
|-------|------|
| Backend Model | `internal/domain/models/docsystem/file_type.go` |
| Backend Model | `internal/domain/models/docsystem/document.go` |
| Backend Service | `internal/service/docsystem/document.go` |
| Frontend | `src/core/editor/types/editorRegistry.ts` |

---

## Related

- [Backend API](backend-api.md) - Document CRUD operations
- [Database Schema](/_docs/technical/backend/database/schema.md) - `documents` table structure
