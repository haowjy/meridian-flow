# Docsystem & Collab Domain — Migration Audit

Audit of every interface, model, and service in `backend/internal/domain/docsystem/` and `backend/internal/domain/collab/` against the filesystem redesign: text files stay in DB (Yjs collab state already lives there), binary files go to Supabase Storage bucket, a metadata layer unifies them into one project tree.

The separate `datasets` domain collapses into this unified filesystem — "dataset" becomes a folder with metadata tags.

---

## Models

### `Document` — TRANSFORMS

The `Document` struct is the central model and every field needs examination:

| Field | Verdict | Rationale |
|-------|---------|-----------|
| `ID` | **Survives** | Primary key, referenced by collab layer |
| `ProjectID` | **Survives** | Project scoping unchanged |
| `FolderID` | **Survives** | Tree placement unchanged |
| `Name` | **Survives** | Display name, file-type agnostic |
| `Extension` | **Survives** | Now covers arbitrary extensions (`.dcm`, `.py`, `.csv`, `.stl`), not just the current allowlist |
| `Description` | **Survives** | Useful for any file |
| `Autoapply` | **Survives** | Proposal auto-apply policy, only meaningful for text files but harmless on binary |
| `FileType` | **Transforms** | Current enum (markdown/skill/agent/tool/excalidraw/mermaid/image/pdf) is fiction-platform-specific. Replace with a broader classification: `text` (DB-stored, collab-capable), `binary` (bucket-stored). The old granular types become metadata tags or are derived from extension/MIME type at the handler layer. The critical distinction is storage routing: text → DB content column, binary → bucket |
| `StorageURL` | **Survives** | Already exists as `*string`. For binary files, points to bucket path. For text files, remains nil (content in DB) |
| `MimeType` | **Survives** | Already exists as `*string`. Becomes required for binary files, derived for text |
| `SizeBytes` | **Survives** | Already exists as `*int64`. Required for binary files, computed for text |
| `Content` | **Transforms** | Currently `string` holding markdown. In the new world: populated for text files (DB-stored), empty string for binary files (content in bucket). The column stays but its semantic contract narrows to "text file content only." Binary files MUST NOT write content here |
| `Metadata` | **Survives** | JSONB is already extensible. Currently holds `{"markdown": {"wordCount": N}}`. New world adds format-specific metadata: `{"dicom": {"modality": "CT", ...}}`, `{"mesh": {"vertices": N}}`, etc. The `DatasetMetadata` struct from the datasets domain collapses into this |
| `PendingProposalCount` | **Survives** | Only meaningful for text files with collab, but already a tree metadata field |
| `Path` | **Survives** | Computed display path, file-type agnostic |
| `CreatedAt/UpdatedAt/DeletedAt` | **Survives** | Standard timestamps |

**Key changes to Document:**
1. `FileType` enum gets replaced with a storage-routing classification (text vs binary) plus MIME type for specifics
2. `Content` becomes conditionally populated — empty for binary files
3. Helper methods `WordCount()`, `SetMarkdownWordCount()`, `ClearMarkdownMetadata()` survive but only apply when `IsTextBased()` returns true
4. New helper: `IsTextBased() bool` — the routing decision for storage and collab eligibility
5. `EnsureFileType()` needs rewrite — current logic defaults unknown extensions to markdown, which is wrong when `.dcm` files exist

### `Folder` — SURVIVES

No changes needed. The `Folder` struct is already file-type agnostic:
- `ID`, `ProjectID`, `ParentID`, `Name`, `Path` — all generic
- `IsHidden`, `IsSystem` — still useful (system folders for internal structure)
- `Description`, `Autoapply` — still useful
- `Metadata` — JSONB, already extensible. Can hold dataset-level metadata (modality, scan info) when a folder represents what was previously a "dataset"

The concept of "dataset = folder with metadata" works directly with this model. A DICOM dataset becomes a folder where `Metadata` holds `{"dataset": {"modality": "CT", "status": "ready", ...}}`.

### `Project` — SURVIVES

Fully file-type agnostic already. `SystemPrompt` will evolve for the research platform but that's a separate concern. `Preferences` JSONB can hold any project-level settings. No structural changes needed.

### `DocumentMetadata` (`map[string]interface{}`) — SURVIVES

The type itself is a generic JSONB map, which is exactly what's needed for heterogeneous file metadata. The markdown-specific helpers on Document are the only narrowing, and they remain valid for text files.

### `ProjectTree` / `TreeFolder` / `TreeDocument` — TRANSFORMS

**TreeFolder** — survives as-is. Already generic.

**TreeDocument** — needs new fields for the unified tree:
- Add `StorageURL *string` — so the tree can indicate binary file download paths
- Add `MimeType *string` — so the frontend knows how to render/preview
- Add `SizeBytes *int64` — so the frontend can show file sizes
- `FileType` field semantics change (see Document above)

**ProjectTree** — struct survives but the tree now includes binary file nodes alongside text files. No structural change, just a wider population.

### `SearchOptions` / `SearchResults` / `SearchResult` — TRANSFORMS

Currently searches `name` and `content` fields. In the new world:
- **Name search** — survives for all files
- **Content search** — only meaningful for text files (binary content isn't in DB). The FTS query must filter to text files when searching content, or accept that binary files only match on name/metadata
- **New search field**: `metadata` — search within JSONB metadata (e.g., find datasets by modality, find files by MIME type)
- `SearchField` enum needs `SearchFieldMetadata`
- `SearchResult.Document` still works — `Document` struct already holds metadata

The search infrastructure is reusable but needs scope awareness.

### `UploadedFile` — TRANSFORMS

Currently `{Filename string, Content io.Reader}`. For binary files, the content goes to bucket (not DB). The struct itself is fine but the processing pipeline behind it changes completely — binary files get uploaded to Supabase Storage, text files get their content extracted and stored in DB.

### `CollabDocRef` — SURVIVES

`{DocumentID, ProjectID}` — minimal cross-domain ref. Works for any file that has collab enabled (i.e., text files). No change needed.

---

## Interfaces — Docsystem

### `DocumentReader` — TRANSFORMS

```go
type DocumentReader interface {
    GetByID(ctx context.Context, id, projectID string) (*Document, error)
    GetByIDOnly(ctx context.Context, id string) (*Document, error)
    GetByPath(ctx context.Context, path string, projectID string) (*Document, error)
    ListByFolder(ctx context.Context, folderID *string, projectID string) ([]Document, error)
    GetAllMetadataByProject(ctx context.Context, projectID string) ([]Document, error)
}
```

**All 5 methods survive**, but the implementation changes:
- `GetByID` / `GetByIDOnly` — for binary files, `Content` will be empty. Callers that need binary content must follow the `StorageURL` to bucket. The reader doesn't fetch bucket content.
- `GetByPath` — same semantics, works for any file type
- `ListByFolder` — now returns a mix of text and binary files. May need a filter option (`TextOnly`, `BinaryOnly`) for callers that only want one kind
- `GetAllMetadataByProject` — already metadata-only (used for tree building). Works as-is

**The ISP split still makes sense.** Read-only access to file metadata is a valid narrow interface that many consumers need (tree service, collab resolver, search).

### `DocumentWriter` — TRANSFORMS

```go
type DocumentWriter interface {
    Create(ctx context.Context, doc *Document) error
    Update(ctx context.Context, doc *Document) error
    Delete(ctx context.Context, id, projectID string) error
    DeleteAllByProject(ctx context.Context, projectID string, skipSystemFolders bool) error
}
```

**All 4 methods survive**, but:
- `Create` — for binary files, must NOT write to `Content` column. Must validate that binary docs have `StorageURL` set and text docs have `Content` set
- `Update` — same split. Binary file metadata updates don't touch `Content`
- `Delete` — for binary files, must also delete from Supabase Storage bucket. This is a **significant change**: the writer needs a storage client dependency, or deletion is orchestrated at the service layer (which already exists as `DocumentService.DeleteDocument`)
- `DeleteAllByProject` — same: must cascade to bucket cleanup

**Decision point**: Should `DocumentWriter` gain a storage client dependency, or should bucket cleanup be service-layer orchestration? Recommendation: **service-layer orchestration**. The store interface stays DB-only (SRP), and `DocumentService.DeleteDocument` handles the two-phase delete (DB + bucket). This matches the existing pattern where store = persistence, service = business logic.

### `DocumentSearcher` — TRANSFORMS

```go
type DocumentSearcher interface {
    SearchDocuments(ctx context.Context, options *SearchOptions) (*SearchResults, error)
}
```

**Survives** but implementation must handle the text/binary split:
- Content FTS only applies to text files
- Name search applies to all files
- Future: metadata JSONB search for binary file attributes

The interface itself doesn't change — `SearchOptions` absorbs the new capabilities.

### `DocumentPathResolver` — SURVIVES

```go
type DocumentPathResolver interface {
    GetPath(ctx context.Context, doc *Document) (string, error)
}
```

Path resolution is file-type agnostic. A binary file has a path in the tree just like a text file. No changes.

### `PathNotationResolver` — SURVIVES

```go
type PathNotationResolver interface {
    ResolveFolderPath(ctx context.Context, projectID, folderPath string) (*string, error)
    ValidateFolderPath(path string) error
    ResolvePathNotation(ctx context.Context, req *PathNotationRequest) (*PathNotationResult, error)
}
```

All path resolution logic is file-type agnostic. Folder creation, path validation, slash-notation — all work for any file type. No changes needed.

### `DocumentStore` (composite) — SURVIVES

```go
type DocumentStore interface {
    DocumentReader
    DocumentWriter
    DocumentSearcher
    DocumentPathResolver
}
```

Composite interface survives. Still the right shape for repository implementations that provide all four capabilities.

**ISP verdict: the Reader/Writer/Searcher/PathResolver split remains valid.** Consumers continue to depend on the narrowest interface they need. The split actually becomes *more* valuable when binary files enter the picture — a component that only reads metadata doesn't need to know about bucket storage.

### `DocumentService` — TRANSFORMS

```go
type DocumentService interface {
    CreateDocument(ctx context.Context, req *CreateDocumentRequest) (*Document, error)
    GetDocument(ctx context.Context, userID, documentID string) (*Document, error)
    GetDocumentByPath(ctx context.Context, userID, path, projectID string) (*Document, error)
    UpdateDocument(ctx context.Context, userID, documentID string, req *UpdateDocumentRequest) (*Document, error)
    DeleteDocument(ctx context.Context, userID, documentID string) error
    SearchDocuments(ctx context.Context, userID string, req *SearchDocumentsRequest) (*SearchResults, error)
}
```

All methods survive but the service gains significant new responsibilities:

1. **`CreateDocument`** — must route: text files → write content to DB, binary files → write metadata to DB + content to bucket. `CreateDocumentRequest` needs new fields: `StorageURL`, `MimeType`, `SizeBytes` for binary files, or a separate `CreateBinaryFileRequest`
2. **`DeleteDocument`** — must orchestrate two-phase delete for binary files (DB metadata + bucket content)
3. **`UpdateDocument`** — binary files: metadata-only updates (rename, move, description). Content updates go through bucket, not this service
4. **`GetDocument`** — for binary files, returns metadata + `StorageURL` (no content). Caller fetches content from bucket if needed

**New methods needed:**
- `GetUploadURL(ctx, userID, projectID, path string) (string, error)` — pre-signed URL for binary upload
- `GetDownloadURL(ctx, userID, docID string) (string, error)` — pre-signed URL for binary download

The `CreateDocumentRequest` and `UpdateDocumentRequest` types transform to handle the text/binary split.

### `FolderStore` — SURVIVES

All 13 methods are file-type agnostic. Folder CRUD, path resolution, hidden/system folder management — none of this changes. This is the cleanest survival in the audit.

### `FolderService` — SURVIVES

`CreateFolder`, `GetFolder`, `UpdateFolder`, `DeleteFolder`, `ListChildren` — all generic. `FolderContents` returns `[]Document` which will now include both text and binary files. No interface changes needed.

### `ProjectStore` — SURVIVES

Fully generic. Create, Get, List, Update, Delete, slug management, activity timestamps. No changes.

### `ProjectService` — SURVIVES

Same. `CreateProject`, `GetProject`, `ListProjects`, `UpdateProject`, `DeleteProject`. No changes needed.

### `FavoriteStore` / `FavoriteService` — SURVIVES

Project-level favoriting. Completely unrelated to file types. No changes.

### `TreeService` — TRANSFORMS

```go
type TreeService interface {
    GetProjectTree(ctx context.Context, userID, projectID string) (*ProjectTree, error)
    GetProjectTreeWithOptions(ctx context.Context, userID, projectID string, opts TreeOptions) (*ProjectTree, error)
}
```

Interface survives but the tree now contains binary file nodes. Implementation must:
- Include binary files in the tree (currently only includes documents with DB content)
- Populate new `TreeDocument` fields (`StorageURL`, `MimeType`, `SizeBytes`)
- Potentially add `TreeOptions.FileTypeFilter` to let callers request only text or only binary files

The tree is the primary way the frontend and sandbox see the unified filesystem, so this is a high-impact transform.

### `ImportService` — TRANSFORMS

```go
type ImportService interface {
    DeleteAllDocuments(ctx context.Context, userID string, projectID string) error
    ProcessFiles(ctx context.Context, projectID, userID string, files []UploadedFile, folderPath string, overwrite bool) (*ImportResult, error)
}
```

**Survives conceptually but transforms significantly:**
- `ProcessFiles` must handle binary files → bucket upload, not just text conversion
- `DeleteAllDocuments` must cascade to bucket cleanup
- The `ImportResult` / `ImportSummary` types are generic enough to survive
- This is where ZIP upload (e.g., DICOM stack as ZIP) gets handled — extract to bucket, create metadata entries
- The `DatasetService.Create` + `FinalizeUpload` flow from the datasets domain **collapses into this**. Import a folder of DICOM files = create folder + import binary files + extract metadata

### `ContentAnalyzer` — TRANSFORMS

```go
type ContentAnalyzer interface {
    CountWords(markdown string) int
    CleanMarkdown(markdown string) string
}
```

Word count and markdown cleaning are text-file-only operations. They survive but narrow in scope:
- Still called for text files on create/update
- Never called for binary files
- Could be renamed to `TextAnalyzer` to clarify scope
- Future: add format-specific analyzers for other file types (DICOM metadata extraction, mesh vertex counting) as separate interfaces following the same pattern

The fiction-specific "word count" concept generalizes to "text statistics." The interface shape is fine; the name could be more general.

### `ContentConverter` — TRANSFORMS

```go
type ContentConverter interface {
    Convert(ctx context.Context, input []byte) (markdown string, err error)
    SupportedExtensions() []string
    Name() string
}
```

Currently converts docx/html/txt → markdown for import. In the new world:
- **Text file converters survive** — still need to convert uploaded .docx/.html/.txt to markdown for DB storage
- **Binary files skip conversion** — they go straight to bucket
- The interface pattern (strategy per file type) extends naturally: new converters for metadata extraction (DICOM → metadata JSON, STL → mesh stats)
- Consider renaming to `FileConverter` or splitting into `TextConverter` (produces markdown) and `MetadataExtractor` (produces metadata JSON)

### `FileProcessor` — TRANSFORMS

```go
type FileProcessor interface {
    CanProcess(filename string) bool
    Process(ctx context.Context, ...) (*ImportResult, error)
    Name() string
}
```

Strategy pattern for import processing. Survives and becomes more important — new processors for:
- ZIP extraction (already exists, extends to binary content)
- DICOM stack processing (extract metadata, store files in bucket)
- Generic binary file processing (store in bucket, detect MIME type)

The interface is well-designed for extension. No structural changes needed.

### `NamespaceService` — SURVIVES

```go
type NamespaceService interface {
    NormalizePath(path string) (string, error)
    ParsePath(path string) (namespace Namespace, relativePath string, err error)
    EnsureMeridianFolder(ctx context.Context, projectID string) (*Folder, error)
    EnsureMeridianSubfolder(ctx context.Context, projectID, name string) (*Folder, error)
}
```

Path normalization, namespace routing (`.meridian/`, `.session/`, `.agents/`), traversal prevention — all file-type agnostic. The namespace concept applies equally to binary and text files. No changes needed.

### `FileType` enum — DIES (replaced)

```go
const (
    FileTypeMarkdown   FileType = "markdown"
    FileTypeSkill      FileType = "skill"
    FileTypeAgent      FileType = "agent"
    FileTypeTool       FileType = "tool"
    FileTypeExcalidraw FileType = "excalidraw"
    FileTypeMermaid    FileType = "mermaid"
    FileTypeImage      FileType = "image"
    FileTypePDF        FileType = "pdf"
)
```

**This enum is the hardest-coded fiction-platform artifact.** It conflates two concerns:
1. **Storage routing** (text vs binary) — the critical distinction
2. **UI behavior** (which editor to show) — a frontend concern

**Replace with:**
- `StorageType` enum: `text` | `binary` — the backend routing decision
- `MimeType` string — the universal file type identifier (already on the Document model)
- Frontend derives editor choice from MIME type + extension, not a backend enum

The helper functions `FileTypeFromExtension`, `IsValidExtension`, `IsTextBasedFileType`, `IsMarkdownExtension` all die or transform:
- `IsTextBasedFileType` → `IsTextStorageType(ext string) bool` — returns true for extensions stored in DB (`.md`, `.txt`, `.mmd`, `.mermaid`, `.excalidraw`, `.py`, `.csv`, etc.)
- `FileTypeFromExtension` → replaced by MIME type detection library
- `IsValidExtension` → **dies**. All extensions are valid now
- `ExtensionToFileType` map → replaced by MIME type detection + a small text-extension allowlist

### `ExtensionToFileType` map — DIES

Hardcoded mapping of 7 extensions to file types. In a world with `.dcm`, `.py`, `.csv`, `.xlsx`, `.stl`, `.obj`, `.zip`, `.pdf`, `.nii.gz`, this approach doesn't scale. Replace with MIME type detection (Go's `mime.TypeByExtension` + custom overrides for domain-specific types like DICOM).

---

## Interfaces — Collab

### `DocumentResolver` — TRANSFORMS

```go
type DocumentResolver interface {
    ResolveDocument(ctx context.Context, docID string) (*CollabDocRef, error)
    VerifyOwnership(ctx context.Context, docID string, userID string) (bool, error)
}
```

The bridge between collab and docsystem. Currently resolves any document for collab. In the new world:
- **Must gate on storage type**: only text files (DB-stored content) are collab-eligible. Attempting to open a collab session on a binary file should return a clear error
- `ResolveDocument` should check `IsTextBased()` and reject binary files
- `VerifyOwnership` is unchanged — ownership check is file-type agnostic

Interface shape survives. Implementation adds a guard.

### `AutoapplyResolver` — SURVIVES

```go
type AutoapplyResolver interface {
    ResolveEffectiveAutoapply(ctx context.Context, documentID string) (bool, error)
}
```

Only meaningful for collab-eligible (text) files, but the interface doesn't need to change — callers already know they're in a collab context when they call this.

### `DocumentStateStore` — SURVIVES

```go
type DocumentStateStore interface {
    LoadState(ctx context.Context, docID string) ([]byte, error)
    SaveState(ctx context.Context, docID string, state []byte, content string) error
}
```

Yjs state persistence. Only used for text files. No interface change — the collab layer already only operates on documents that passed through `DocumentResolver`, which will gate on text files.

### `CheckpointStore` — SURVIVES

Yjs compaction. Same reasoning — only operates within the collab layer on text files. No changes.

### `ProjectedStateBuilder` — SURVIVES

Builds projected Yjs state with pending proposals. Text-file-only, already scoped correctly. No changes.

### `DocumentContentLoader` — SURVIVES

```go
type DocumentContentLoader interface {
    LoadContentForBootstrap(ctx context.Context, docID string) (string, error)
}
```

Loads raw markdown for Yjs bootstrap. Only text files have DB content to load. No changes — the collab session creation path already resolves through `DocumentResolver`.

### `DocumentSessionProvider` / `SyncSession` — SURVIVES

Session management and Yjs sync protocol. Internal to collab, operates only on resolved (text) documents. No interface changes needed.

### All other collab interfaces — SURVIVES

`ProposalStore`, `ProposalService`, `UpdateLogStore`, `BookmarkStore`, `DocumentPresenceTracker`, `StatusMirror`, `RestoreService`, `DocumentStateManager` — all internal to the collab domain, all operate on documents that already passed the resolver gate. None need interface changes.

---

## Summary Table

| Component | Verdict | Key Change |
|-----------|---------|------------|
| **Document** model | TRANSFORMS | `FileType` → storage routing + MIME; `Content` conditional on text; binary fields promoted |
| **Folder** model | SURVIVES | Absorbs "dataset" concept via metadata |
| **Project** model | SURVIVES | No changes |
| **TreeDocument** model | TRANSFORMS | Add `StorageURL`, `MimeType`, `SizeBytes` |
| **FileType** enum | DIES | Replace with `StorageType` (text/binary) + MIME type |
| **ExtensionToFileType** map | DIES | Replace with MIME detection + text-extension allowlist |
| **DocumentReader** | TRANSFORMS | Returns empty content for binary files |
| **DocumentWriter** | TRANSFORMS | Validates storage routing on write |
| **DocumentSearcher** | TRANSFORMS | Content search restricted to text files |
| **DocumentPathResolver** | SURVIVES | File-type agnostic |
| **PathNotationResolver** | SURVIVES | File-type agnostic |
| **DocumentStore** (composite) | SURVIVES | Inherits transforms from constituents |
| **DocumentService** | TRANSFORMS | Routes text/binary, gains upload/download URL methods |
| **FolderStore** | SURVIVES | All methods file-type agnostic |
| **FolderService** | SURVIVES | All methods file-type agnostic |
| **ProjectStore** | SURVIVES | No changes |
| **ProjectService** | SURVIVES | No changes |
| **FavoriteStore/Service** | SURVIVES | No changes |
| **TreeService** | TRANSFORMS | Tree includes binary files, new TreeDocument fields |
| **ImportService** | TRANSFORMS | Routes binary → bucket, absorbs dataset upload |
| **ContentAnalyzer** | TRANSFORMS | Scope narrows to text files; rename candidate |
| **ContentConverter** | TRANSFORMS | Text converters survive; binary files skip conversion |
| **FileProcessor** | TRANSFORMS | New processors for binary types, DICOM extraction |
| **NamespaceService** | SURVIVES | Path logic is file-type agnostic |
| **collab.DocumentResolver** | TRANSFORMS | Gate collab to text-only files |
| **collab.AutoapplyResolver** | SURVIVES | Already scoped to collab context |
| **collab.DocumentStateStore** | SURVIVES | Text-file-only by construction |
| **collab.CheckpointStore** | SURVIVES | Text-file-only by construction |
| **collab.ProjectedStateBuilder** | SURVIVES | Text-file-only by construction |
| **collab.DocumentContentLoader** | SURVIVES | Text-file-only by construction |
| **collab.DocumentSessionProvider** | SURVIVES | No changes |
| **collab.SyncSession** | SURVIVES | No changes |
| **All other collab interfaces** | SURVIVES | Internal to collab, behind resolver gate |

---

## Dataset Domain Collapse

The standalone `datasets` domain (`backend/internal/domain/datasets/`) **dies entirely**:

| Dataset concept | Replacement |
|-----------------|-------------|
| `Dataset` struct | Folder with `Metadata["dataset"]` containing status, modality, etc. |
| `DatasetStatus` enum | `Folder.Metadata["dataset"]["status"]` |
| `DatasetMetadata` struct | `Folder.Metadata["dataset"]` JSONB |
| `Dataset.FileCount` | Computed from documents in folder |
| `Dataset.TotalSizeBytes` | Computed from `SizeBytes` of documents in folder |
| `Dataset.Service.Create` | `FolderService.CreateFolder` + set metadata |
| `Dataset.Service.FinalizeUpload` | `ImportService.ProcessFiles` + metadata extraction |
| `Dataset.Service.GetUploadURL` | `DocumentService.GetUploadURL` |
| `Dataset.Repository` | Eliminated — folders and documents handle persistence |

This is the right move. The datasets domain was a parallel filesystem — separate tables, separate CRUD, separate upload flow — for what is conceptually just "a folder of binary files with metadata." The unified filesystem makes datasets a first-class folder pattern rather than a separate domain.

---

## Migration Risk Assessment

**Low risk (rename/extend):**
- Folder model, Project model, FavoriteStore/Service, NamespaceService, PathResolver — these just work

**Medium risk (implementation changes, interface stable):**
- DocumentReader/Writer/Searcher — implementation changes for text/binary routing, but interfaces are close to final shape
- TreeService — needs new fields on TreeDocument, implementation queries both text and binary files
- Collab DocumentResolver — add one guard

**High risk (significant redesign):**
- FileType system — the enum, extension maps, and all branching logic that depends on them must be replaced. This is load-bearing code with tendrils throughout handlers, services, and repository queries
- ImportService — absorbs dataset upload, binary file routing, ZIP extraction to bucket, metadata extraction. The interface is simple but the implementation is complex
- DocumentService — becomes the orchestrator for text/binary routing, pre-signed URLs, two-phase deletes. This is where most new complexity lands

**New infrastructure needed:**
- Supabase Storage client (bucket operations: upload, download, delete, list, pre-signed URLs)
- MIME type detection (Go standard library + custom overrides)
- Binary file metadata extractors (DICOM header parsing, mesh stats, etc.)
- Storage routing logic (`IsTextBased(extension) bool` — the single function that determines where content lives)
