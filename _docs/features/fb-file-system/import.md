---
stack: backend
status: complete
feature: "ZIP Import"
---

# ZIP Import

**Bulk import markdown files from ZIP archives.**

## Backend: ✅ Complete

**Implementation**: `backend/internal/service/docsystem/import.go`

**Features**:
- Process ZIP archives with markdown files
- Two modes:
  - **Append** (default): Upsert documents (create new, update existing)
  - **Replace**: Delete all documents first, then import
- Auto-create folders from directory structure
- Path-based conflict resolution
- Import statistics (created, updated, skipped, failed counts)

**Supported formats**:
- `.md, .markdown` - Passthrough
- `.txt, .text` - Passthrough with whitespace preservation
- `.html, .htm` - HTML → Markdown conversion

**Missing formats**: `.docx`, `.pdf`, `.rtf`

**Endpoints**:
- `POST /api/import` - Merge import
- `POST /api/import/replace` - Replace import

---

## Frontend: ✅ Complete

**Implementation**: `frontend/src/features/documents/components/ImportDocumentDialog.tsx`

**Features**:
- Drag-and-drop file upload
- Multi-file selection (.zip, .md, .txt, .html)
- Overwrite toggle (skip vs overwrite existing documents)
- Progress indicator during upload
- Results summary (created, updated, skipped, failed counts)
- File validation with error display

---

## Related

- See `backend/internal/service/docsystem/converter/` for file format converters
