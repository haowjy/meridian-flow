---
stack: both
status: complete
feature: document-import
detail: standard
audience: developer
---

# Document Import

**Stack:** Backend + Frontend
**Status:** ✅ Complete

Multi-format document import system supporting zip archives, folders, and individual files with automatic format conversion and XSS sanitization.

## Overview

The import system allows users to bulk-import documents from:
- **Folders** - Browser folder picker with client-side zip compression
- **Zip archives** - Nested folder structure preserved
- **Individual files** - Single document upload
- **Multiple formats** - Markdown (.md), Plain text (.txt), HTML (.html, .htm)

## Architecture

### Backend

**Pattern:** Strategy Pattern + Factory Pattern

```
FileProcessorRegistry
├── ZipFileProcessor (handles .zip)
└── IndividualFileProcessor (handles single files)

ConverterRegistry
├── MarkdownConverter (.md) - Pass-through
├── TextConverter (.txt) - Plain text → Markdown
└── HTMLConverter (.html, .htm) - HTML → Markdown + XSS sanitization
```

**Flow:**
1. Client uploads file(s) via multipart/form-data
2. `ImportService.ProcessFiles()` routes to appropriate file processor
3. Processor extracts files and routes each to content converter
4. Converter transforms content to markdown
5. Service creates documents with converted content

**Security:** HTML imports use `bluemonday` for XSS sanitization before conversion.

### Frontend

**Component:** `ImportDocumentDialog`

**Phases:**
1. **Selection** - Dual dropzones for files and folders
2. **Preview** - Categorized file list with confirmation
3. **Uploading** - Progress indicator during upload
4. **Results** - Success/failure summary with error details

**Validation:**
- File types: .zip, .md, .txt, .html, .htm (folders filter to supported types)
- Size limits: 100MB per file, 100MB total
- Client-side validation before upload
- System files auto-excluded (.git, node_modules, .DS_Store, etc.)

## Features

| Feature | Backend | Frontend | Notes |
|---------|---------|----------|-------|
| Folder import | N/A | ✅ | Client-side JSZip compression |
| Zip import | ✅ | ✅ | Folder structure preserved |
| Markdown import | ✅ | ✅ | Pass-through (no conversion) |
| Text import | ✅ | ✅ | Auto-converts to markdown |
| HTML import | ✅ | ✅ | XSS sanitization + conversion |
| Drag-and-drop | N/A | ✅ | Separate zones for files/folders |
| Preview confirmation | N/A | ✅ | Review before upload |
| System file filtering | ✅ | ✅ | Defense-in-depth: both filter .git, __MACOSX, etc. |
| Error reporting | ✅ | ✅ | Detailed per-file errors |
| Multipart upload | ✅ | ✅ | Multiple files in single request |

## Status

✅ **Production Ready**
- Backend: Strategy-based architecture with extensible converters
- Frontend: Polished UI with validation and error handling
- Security: XSS protection for HTML imports
- Testing: Validated with multiple file formats

## Links

- **Backend Architecture:** [backend-architecture.md](./backend-architecture.md)
- **Frontend UI:** [frontend-ui.md](./frontend-ui.md)
- **Supported Formats:** [supported-formats.md](./supported-formats.md)
- **API Contracts:** `_docs/technical/backend/api/contracts.md` (import section)

## Key Files

### Backend
- `backend/internal/service/docsystem/import.go:29` - Main import service
- `backend/internal/service/docsystem/converter/` - Content converters
- `backend/internal/service/docsystem/*_file_processor.go` - File processors
- `backend/internal/handler/document.go:ImportDocuments()` - API endpoint

### Frontend
- `frontend/src/features/documents/components/ImportDocumentDialog.tsx` - Main dialog
- `frontend/src/features/documents/components/ImportFileSelector.tsx` - Dual dropzones
- `frontend/src/features/documents/components/ImportPreview.tsx` - Preview confirmation
- `frontend/src/features/documents/utils/importProcessing.ts` - Folder processing, JSZip
- `frontend/src/features/documents/utils/importFilters.ts` - System file filtering
- `frontend/src/features/documents/types/import.ts` - Import types
- `frontend/src/core/lib/api.ts:documents.import()` - API client
