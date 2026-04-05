# Filesystem Redesign — Impact on Biomedical MVP

How the unified filesystem layer changes the biomedical MVP design. See [filesystem-layer.md](filesystem-layer.md) for the full design and [overview](../overview.md) for the original MVP plan.

## Dataset Domain Collapses

The standalone `datasets` domain ([dataset-domain.md](dataset-domain.md)) is **eliminated**. Every concept it introduced maps directly to the unified filesystem:

| Dataset concept | Filesystem replacement |
|-----------------|----------------------|
| `Dataset` struct | Folder with `Metadata["dataset"]` JSONB |
| `DatasetStatus` enum (uploading/processing/ready/error) | `Folder.Metadata["dataset"]["status"]` |
| `DatasetMetadata` struct (modality, manufacturer, etc.) | `Folder.Metadata["dataset"]` JSONB namespace |
| `Dataset.FileCount` | Count of documents in folder |
| `Dataset.TotalSizeBytes` | Sum of `SizeBytes` for documents in folder |
| `Dataset.Service.Create` | `FolderService.CreateFolder` + set dataset metadata |
| `Dataset.Service.FinalizeUpload` | Bulk upload finalize endpoint + DICOM metadata extraction |
| `Dataset.Service.GetUploadURL` | `StorageService.GenerateUploadURL` |
| `Dataset.Repository` | Eliminated — Folder + Document repositories handle persistence |
| `datasets` DB table | Eliminated — uses `folders` + `documents` tables |
| `datasets` migration | Eliminated — replaced by filesystem migration |
| `dataset.go` handler | Eliminated — file upload handler covers it |

### What this eliminates from the codebase

```
backend/internal/
  domain/datasets/           # ELIMINATED: entire directory
    types.go
    interfaces.go
  service/datasets/          # ELIMINATED: entire directory  
    service.go
  handler/dataset.go         # ELIMINATED
  repository/postgres/
    dataset.go               # ELIMINATED
  migrations/
    NNNNNN_create_datasets.up.sql   # ELIMINATED
```

Estimated lines of code eliminated: ~500 (domain types + interfaces + service + repository + handler + migration).

### What replaces it

The bulk upload flow in [filesystem-layer.md](filesystem-layer.md) covers everything datasets did:

1. **Create dataset folder**: `POST /api/projects/{pid}/folders` with `metadata: {"dataset": {...}}`
2. **Get upload URLs**: `POST /api/projects/{pid}/files/bulk-upload-urls` with `folder_path: "datasets/knee-001"`
3. **Upload files**: Client uploads to pre-signed URLs (same as dataset design)
4. **Finalize**: `POST /api/projects/{pid}/files/finalize-bulk` — verifies files, extracts DICOM metadata, updates folder metadata
5. **List datasets**: `GET /api/projects/{pid}/tree` and filter for folders with `dataset` metadata

## Impact on MVP Implementation Phases

### Phase 1: Sandbox Service — UNCHANGED
The Daytona sandbox lifecycle, kernel management, and workspace setup are independent of how files are stored. The sandbox accesses files through the backend API regardless.

**One addition**: The sandbox hydration step (copying project files to `/workspace/`) now uses the unified file access API instead of a dataset-specific one. This is simpler, not harder.

### Phase 2: Python + Bash Tools — UNCHANGED
Tool execution is independent of file storage. The `python` and `bash` tools interact with the sandbox filesystem, not the storage layer directly.

### Phase 3: Display Results — UNCHANGED
Result rendering (charts, tables, meshes) is independent of file storage.

### Phase 4: Dataset Domain → REPLACED by Filesystem Layer
This is the major change. Instead of implementing a separate dataset domain:

**Before**: Build `domain/datasets/`, `service/datasets/`, `handler/dataset.go`, `repository/postgres/dataset.go`, `create_datasets` migration.

**After**: Extend `domain/docsystem/` with `StorageType`, `StorageService`, `MetadataExtractor`. Add file upload handler. Add filesystem migration.

The work is roughly equivalent in scope but produces a more general solution. The filesystem layer handles DICOM uploads AND future file types (Python scripts, meshes, PDFs, etc.) without additional domain work.

### Phase 5–8: Frontend — MINOR CHANGES
- **Dataset Upload UI**: Instead of `POST /api/projects/{pid}/datasets`, calls `POST /api/projects/{pid}/files/bulk-upload-urls`. The drag-and-drop UI is the same.
- **Dataset store**: Instead of `dataset-store.ts` with `Dataset` type, uses the project tree with folder metadata. Slightly simpler Zustand store.
- **Dataset list**: Filters project tree for folders with `dataset` metadata instead of calling a dedicated datasets endpoint.

### Phase 9: Dataset Upload → REPLACED by File Upload
This phase was "wire up dataset upload end-to-end." It becomes "wire up bulk file upload end-to-end" — same scope, more general.

## Changes to Overview Architecture Diagram

The `DatasetSvc` box in the architecture diagram becomes part of the existing document/file service:

```
Before:
  DatasetSvc["Dataset Service (new domain)"] -->|"Storage API"| Supabase

After:
  DocSvc["Document Service (extended)"] -->|"StorageService"| Supabase
```

The `handler/dataset.go` HTTP endpoints merge into `handler/file_upload.go`.

## Changes to Directory Map

```diff
backend/
  internal/
-   domain/datasets/           # REMOVED
-   service/datasets/          # REMOVED
+   domain/docsystem/
+     storage_type.go          # NEW
+     storage_service.go       # NEW
+     metadata_extractor.go    # NEW
+   service/docsystem/
+     storage.go               # NEW: StorageService impl
+     metadata/
+       dicom_extractor.go     # NEW: DICOM metadata extraction
+       mime_detector.go       # NEW: MIME type detection
    service/llm/tools/
      python_tool.go
      bash_tool.go
-   handler/dataset.go         # REMOVED
+   handler/file_upload.go     # NEW: upload URL + finalize endpoints
    repository/postgres/
-     dataset.go               # REMOVED
  migrations/
-   NNNNNN_create_datasets.up.sql      # REMOVED
+   NNNNNN_filesystem_layer.up.sql     # NEW: storage_type column + constraints
```

## Frontend Changes

```diff
frontend-v2/
  src/
    features/
      datasets/
-       DatasetPanel.tsx        # Uses dataset-specific API
+       DatasetPanel.tsx        # Uses file tree + folder metadata API
-       hooks/useDatasetUpload.ts   # Dataset-specific upload
+       hooks/useFileUpload.ts      # Generic file upload (bulk pre-signed URLs)
-       hooks/useDatasets.ts        # Dataset list/CRUD
+       hooks/useDatasetFolders.ts  # Filter tree for dataset folders
    stores/
-     dataset-store.ts          # Dataset-specific state
+     dataset-store.ts          # Simplified: derives from project tree
```

## Net Effect

**Complexity reduction**: One storage abstraction instead of two parallel file systems. The document/file system handles everything.

**Scope reduction**: ~500 lines of dataset-specific code eliminated. Replaced by ~300 lines of filesystem extensions (StorageType routing, StorageService, upload handler).

**Generality**: The same infrastructure that handles DICOM uploads also handles any future file type — no new domain work needed for Python scripts, mesh files, PDFs, etc.

**Risk**: The filesystem layer is a prerequisite for multiple MVP phases. If it ships with bugs, more things break than if datasets were isolated. Mitigation: the filesystem layer is a thin wrapper around well-understood primitives (Supabase Storage API, Postgres metadata).
