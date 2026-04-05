# Filesystem Layer — Implementation Review

**Reviewer:** Claude Code  
**Date:** 2026-04-05  
**Scope:** `filesystem-layer.md` + `filesystem-mvp-impact.md` against `dataset-domain.md` and `requirements.md`  
**Focus:** Implementability, completeness, agent navigability, dataset collapse fidelity, MVP scope  

---

## Overall Assessment

The design is architecturally sound. The "dataset = folder with metadata" collapse is correct and saves real code. The storage routing logic (allowlist for text, bucket for binary) is well-reasoned. The existing codebase is further along than the design implies — `storage_url`, `mime_type`, and `size_bytes` already exist on the Document struct and in the DB schema, which makes the migration lighter than it looks.

**However, the design has several implementation blockers.** A coder agent would get stuck at the new endpoints because request/response structs are entirely absent. There's also a missing `status` field that the sequence diagrams reference but never define, and the sandbox file write-back path calls "the backend API" without specifying which endpoint. These gaps need resolution before implementation starts.

**Verdict: Request changes.** The architecture is approved. The five blocking gaps below need to be filled before a coder can proceed.

---

## Blocking Gaps

### 1. Request/response structs for all 5 new endpoints are missing

The endpoint table lists routes but gives no Go struct definitions. A coder implementing `file_upload.go` would have to invent these from scratch, which means inconsistency with the rest of the codebase.

**Affected endpoints:**
```
POST /api/projects/{pid}/files/upload-url
POST /api/projects/{pid}/files/bulk-upload-urls
POST /api/files/{id}/finalize
POST /api/projects/{pid}/files/finalize-bulk
GET  /api/files/{id}/download
```

**What's needed:** Add Go struct definitions for each request body and response body — same style as `CreateDocumentRequest` in `domain/docsystem/document.go`. At minimum:

```go
type UploadURLRequest struct {
    Name       string  `json:"name"`
    FolderPath *string `json:"folder_path,omitempty"`
    FolderID   *string `json:"folder_id,omitempty"`
    MimeType   *string `json:"mime_type,omitempty"`
    SizeBytes  *int64  `json:"size_bytes,omitempty"`
}

type UploadURLResponse struct {
    DocumentID string    `json:"document_id"`
    UploadURL  string    `json:"upload_url"`
    ExpiresAt  time.Time `json:"expires_at"`
}

type FinalizeRequest struct{} // body empty or {size_bytes}?

type BulkUploadURLsRequest struct {
    FolderPath string              `json:"folder_path"`
    Files      []BulkFileSpec      `json:"files"`
}

type BulkFileSpec struct {
    Name      string `json:"name"`
    SizeBytes int64  `json:"size_bytes"`
}
```

Without these, two coders would produce incompatible handlers and API clients.

---

### 2. Document `status` field is referenced but never defined

The upload sequence diagrams create documents with `status: uploading` and update them to `status: ready` on finalize. But neither the Document struct nor the migration adds a `status` column.

This is load-bearing: the project tree will show partially-uploaded binary files as real documents. Without a status field, there's no way for the tree endpoint to filter out incomplete uploads, and no way for the UI to show upload progress state.

**Options:**
- Add `UploadStatus *string` to Document struct and a nullable `upload_status` column (NULL = complete, "uploading" = in-progress). Simple, no breaking change.
- Store status in `Metadata["upload"]["status"]` — consistent with the JSONB approach but harder to index/filter.

**Pick one and specify it.** The migration needs updating. The tree query needs to decide whether to include/exclude `status: uploading` documents.

---

### 3. Sandbox `upload_file()` calls "the backend API" — endpoint unspecified

The Python helper is documented:

```python
from meridian_files import upload_file
upload_file("/workspace/output/femur.stl", "results/femur.stl")
```

The doc says it "calls the backend API to create a document metadata row." But there's no endpoint defined for this case. The existing finalize endpoints (`POST /api/files/{id}/finalize`) assume a document row was pre-created by the backend before upload — they update an existing row. The sandbox-created file has no pre-existing row.

**This needs its own endpoint** or an extension of the finalize flow. Possible design:

```
POST /api/projects/{pid}/files/register
Body: {name, folder_path, storage_path, mime_type, size_bytes}
```

The backend creates the document row and returns it. The sandbox helper calls this after a successful S3 PUT. Without this, the sandbox can upload files to the bucket that never appear in the project tree.

---

### 4. Orphan cleanup dropped without replacement

`dataset-domain.md` had an explicit orphan strategy: datasets stuck in `uploading` for >24 hours are marked `error` by a background worker. This was motivated by real behavior — DICOM uploads take time, browsers close, networks drop.

`filesystem-layer.md` drops this entirely. With a document `status` field (see gap #2), orphan rows in `status: uploading` will accumulate silently and appear in the project tree as ghost files.

**Minimum specification needed:**
- How long before an `uploading` document is considered abandoned?
- What happens to it — deleted from DB? Marked error? Left for user to clean up?
- Is this a background job, a lazy cleanup on tree fetch, or manual UI action?

For MVP (single user, controlled uploads), a simple approach is fine: tree queries exclude documents with `upload_status = 'uploading'` AND `created_at < NOW() - INTERVAL '2 hours'`. State this explicitly.

---

### 5. Storage URL must be computed at upload-URL-generation time, not finalize

The design flow creates the document row at upload URL generation time (`status: uploading`) but doesn't specify what `storage_url` is set to at that point. Then finalize "verifies file exists, gets size" and updates `storage_url` to... the same path it should have known all along.

The bucket path is deterministic: `{project_id}/{document_id}/{filename}`. This can and should be computed when the document row is created (before upload). `storage_url` should be set at row creation, not at finalize. Finalize then only needs to:
1. Verify the file exists at `storage_url`
2. Get the actual size
3. Update `size_bytes` and `upload_status → ready`

This avoids a situation where finalize can't locate the file because the path was never persisted. Clarify in the design which fields are set at row creation vs. finalize.

---

## Medium Issues

### 6. `DatasetStatus.processing` is lost

The original dataset domain had four statuses: `uploading → processing → ready | error`. `processing` represented the window where DICOM metadata extraction was running (could take seconds for a 400-slice stack). The filesystem design collapses this to `uploading → ready`.

For the MVP's single user, this is probably fine — metadata extraction is fast for one scan. But the design should acknowledge the gap rather than silently dropping it. If metadata extraction takes >1s, the UI has no way to show "processing" state.

---

### 7. Dataset slug → folder name: sandbox path safety not addressed

`dataset-domain.md` used `dataset.Slug` (URL-safe, `knee-scan-001`) for sandbox paths:
> The bash tool accesses datasets at `/workspace/datasets/{slug}/`

The filesystem design replaces slug with folder name. Folder names can contain spaces and Unicode. The sandbox path `bash tool accesses files at /workspace/datasets/Left Knee - Mouse 42/` is invalid shell syntax without quoting.

The filesystem-layer.md and requirements.md mention that bash tool accesses datasets — this path needs to be specified. Either:
- The sandbox hydration step sanitizes folder names to path-safe strings
- Or the design enforces slug-style folder names for dataset folders
- Or the design documents how sandbox code handles folder names with spaces

---

### 8. Signed URL expiry (5 min) is too short for inline image display

The design specifies 5-minute download URL expiry. The frontend must not cache signed URLs across navigation events. Fine for explicit downloads.

But the MVP's result rendering includes matplotlib PNG output files — stored as binary files in the bucket and displayed **inline in the activity stream**. An `<img src={signedUrl}>` that expires after 5 minutes will silently break in a long session. The image tag has no retry mechanism when a signed URL expires.

**Fix:** For inline display, either:
- Proxy image content through the backend (route returns the bytes, not a redirect)
- Extend expiry to 1 hour for display contexts
- Or design the activity stream result rendering to use the proxy endpoint rather than direct signed URLs

This affects the result rendering design (Phase 3 in the MVP).

---

### 9. `GenerateDownloadURL` interface signature is ambiguous

```go
GenerateDownloadURL(ctx context.Context, projectID, documentID string) (url string, expiresAt time.Time, err error)
```

The interface takes `documentID` but not the storage path. The implementation will need to look up the document row to get `storage_url`. Two options:
- The interface takes the `storageURL` directly (caller looks it up)
- The service layer looks it up internally

Specify which. If the service looks it up internally, then `StorageService` needs a DB dependency (or the lookup happens in `DocumentService` before calling `StorageService`). This is an architectural decision that affects where the DB call lives.

---

## Low-priority / Simplification Notes

### 10. Dual-SDK approach is over-engineering for MVP

The design uses:
- `storage-go` for signed URL generation
- `AWS SDK v2` for large file upload and batch deletion

For a single researcher uploading DICOM stacks, `storage-go` handles everything needed. The AWS SDK v2 adds: S3 credentials setup (separate from Supabase JWT), path-style addressing config, a second dependency, and different error types. The rationale is "parallel chunk upload with automatic retry" — but DICOM uploads happen client-to-bucket (not server-to-bucket), so the Go backend doesn't do the large file upload at all.

The only server-side large upload scenario is "backend hydrates sandbox with DICOM files" — this could use `storage-go`'s download API (generates a signed URL, sandbox fetches via HTTP). No AWS SDK needed.

**Recommendation:** Use `storage-go` exclusively for MVP. Drop the AWS SDK v2 dependency. Add a comment noting it's available if server-side multipart upload becomes necessary.

---

### 11. TUS resumable upload is over-engineering for MVP

TUS requires `tus-js-client` on the frontend and assumes the Supabase TUS endpoint behaves correctly. Supabase's TUS endpoint has historically had quirks (non-standard extension support, unclear behavior on session expiry). For a single researcher in a controlled environment, resumable upload adds complexity that isn't justified.

**Recommendation for MVP:** Standard chunked `fetch` for all file sizes. Supabase Storage's standard upload handles up to 500 MB. If a DICOM stack upload is interrupted, the user re-uploads. The orphan row gets cleaned up (per gap #4). Resume-on-reopen is a v2 feature.

---

### 12. DICOM extractor detail absent

`dicom_extractor.go` is listed in the directory map but the design gives no:
- Library selection (dataset-domain.md recommended `github.com/suyashkumar/dicom` — this should be confirmed and repeated here)
- Which DICOM tags to extract (the DatasetMetadata struct in dataset-domain.md was explicit; the filesystem design only shows a JSON example without tag identifiers)
- De-identification: `PatientID` was explicitly called out in dataset-domain.md as needing de-identification. The filesystem design shows `patientId` in the metadata JSON example without any note about this

This is a data safety issue for a medical imaging platform, even if it's a research context with no real patient data yet. State the de-identification policy explicitly.

---

## Dataset Collapse Validation

| dataset-domain.md concept | Filesystem replacement | Status |
|---------------------------|----------------------|--------|
| `Dataset` struct | Folder with `Metadata["dataset"]` JSONB | ✓ Complete |
| `DatasetStatus.uploading` | `Folder.Metadata["dataset"]["status"]` | ✓ (once gap #2 is resolved) |
| `DatasetStatus.processing` | Missing | ⚠ Lost (see issue #6) |
| `DatasetStatus.ready` | `"ready"` in folder metadata | ✓ |
| `DatasetStatus.error` | Implied but not specified | ⚠ Needs spec |
| `DatasetMetadata` struct fields | JSONB namespace (less type safety) | ✓ Acceptable for MVP |
| `Dataset.Slug` | Folder name | ⚠ Sandbox path safety issue (see issue #7) |
| `Dataset.Description` | `Folder.description` | ✓ Already on Folder struct |
| `Dataset.FileCount` | On-demand DB aggregation | ✓ (performance OK for MVP) |
| `Dataset.TotalSizeBytes` | On-demand DB aggregation | ✓ (performance OK for MVP) |
| `Dataset.Service.Create` | `FolderService.CreateFolder` + metadata | ✓ |
| `Dataset.Service.FinalizeUpload` | `finalize-bulk` endpoint | ✓ (once gap #3 is resolved) |
| `Dataset.Service.GetUploadURL` | `StorageService.GenerateUploadURL` | ✓ |
| `Dataset.Service.List` | Tree filter by `metadata.dataset` | ✓ |
| `Dataset.Service.GetBySlug` | Tree filter by folder name | ✓ (with slug caveat) |
| `Dataset.Service.Delete` | Document delete + folder delete | ✓ (delete cascade OK) |
| Partial upload / resume | Missing | ⚠ Lost — acknowledge this explicitly |
| Orphan cleanup (24hr worker) | Missing | ⚠ Blocking gap #4 |
| `PatientID` de-identification | Mentioned in JSON example, no policy | ⚠ Needs explicit note |

**Net verdict on dataset collapse**: The functional coverage is 85%. The gaps are: `processing` status, resumable upload UX, orphan cleanup, and the slug-to-folder-name sandbox path mapping. For MVP these are acceptable omissions if explicitly acknowledged.

---

## Codebase Alignment (Good News)

Cross-referencing against the actual implementation reveals the migration is simpler than the design implies:

- `storage_url`, `mime_type`, and `size_bytes` **already exist** as nullable columns in the DB schema (added in migration 00029) and are already in the Document struct and repository queries.
- `Folder.Metadata` JSONB **already exists** and is hydrated correctly.
- The migration only needs to: add `storage_type` column, drop the `file_type_check` constraint, add `storage_type` constraint, and add the two new indexes.
- The Document struct changes are minimal — add `StorageType StorageType` field with `db:"storage_type"` tag.

The codebase risk is lower than the design suggests because most of the data model is already in place.

---

## Summary

| # | Severity | Issue | Blocking? |
|---|----------|-------|-----------|
| 1 | HIGH | Request/response structs absent for all 5 new endpoints | Yes |
| 2 | HIGH | Document `status` field referenced in diagrams but undefined | Yes |
| 3 | HIGH | Sandbox `upload_file()` backend endpoint not specified | Yes |
| 4 | HIGH | Orphan cleanup dropped without replacement | Yes |
| 5 | HIGH | Storage URL pre-computation vs finalize timing unspecified | Yes |
| 6 | MEDIUM | `DatasetStatus.processing` silently lost | No |
| 7 | MEDIUM | Dataset slug → folder name: sandbox path safety gap | No |
| 8 | MEDIUM | 5-min signed URL expiry breaks inline image display | No |
| 9 | MEDIUM | `GenerateDownloadURL` signature ambiguity (DB lookup location) | No |
| 10 | LOW | Dual-SDK over-engineering (AWS SDK v2 not needed for MVP) | No |
| 11 | LOW | TUS resumable upload over-engineering for single-user MVP | No |
| 12 | LOW | DICOM extractor: library, tags, de-identification unspecified | No |
