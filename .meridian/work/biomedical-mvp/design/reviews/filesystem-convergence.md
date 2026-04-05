# Filesystem Layer — Convergence Check

**Date**: 2026-04-05  
**Input**: Updated `filesystem-layer.md` checked against 7 high-severity findings from three prior reviews (opus arch, sonnet impl, gpt-5.4)

## Verdict: All blocking issues resolved. Ready for implementation planning.

---

## Issue-by-Issue Resolution

### 1. DB/bucket consistency gap (opus H1, gpt-5.4 #3) — **Resolved**
Design now has a full "Consistency Model" section: field-timing table showing what's set at row creation vs finalize, orphan cleanup strategy (2-hour threshold, lazy cleanup on tree fetch), tree queries that exclude `upload_status = 'uploading'` rows, and a failure-mode table covering all four DB/bucket mismatch cases. Finalize is explicitly idempotent (`UPDATE ... WHERE upload_status = 'uploading'`). Delete order is specified (bucket first, then DB).

### 2. Document `upload_status` field missing (sonnet #2) — **Resolved**
`upload_status` column added to migration with CHECK constraint (`NULL` or `'uploading'`), `UploadStatus *string` added to Document struct, dedicated index for orphan cleanup queries.

### 3. Request/response structs missing (sonnet #1) — **Resolved**
Full Go struct definitions added for all endpoints: `UploadURLRequest/Response`, `BulkUploadURLsRequest/Response`, `BulkFileSpec`, `FinalizeResponse`, `BulkFinalizeRequest/Response`, `RegisterFileRequest`.

### 4. Sandbox file registration endpoint missing (sonnet #3) — **Resolved**
New `POST /api/projects/{pid}/files/register` endpoint defined with `RegisterFileRequest` struct. Creates a document row with `upload_status = NULL` (already complete). Listed in HTTP endpoints table.

### 5. Bulk finalize completeness validation (gpt-5.4 #2) — **Resolved**
`BulkFinalizeRequest` includes `ExpectedCount`. Sequence diagram shows count validation: "reject if >5% missing." Response returns `MissingFiles []string` for partial success transparency.

### 6. Signed URL expiry breaks inline images (sonnet #8) — **Resolved**
New `GET /api/files/{id}/content` endpoint proxies binary content through the backend (max 10 MB). Explicitly designed for `<img>` tags in the activity stream where signed URL expiry would silently break images. Larger files use the redirect endpoint.

### 7. Batch StorageService methods missing (opus M3) — **Resolved**
`StorageService` interface now includes `GenerateUploadURLs`, `GenerateDownloadURLs`, `DeleteFiles`, `GetFilesInfo` batch methods, plus `GetContent` for inline proxy. Supporting types `StorageURLResult` and `StorageFileInfo` defined.

---

## Secondary Items Also Addressed

- **Storage URL timing** (sonnet #5): Field-timing table confirms `storage_url` set at row creation, not finalize.
- **StorageService parameter style** (sonnet #9): Methods take `storagePath` string; callers construct path from document metadata. Explicitly documented.
- **Compound extensions** (opus M1): Documented — `filepath.Ext` governs, compound extensions route by final segment. Correct for all biomedical compounds.
- **Collab gate** (opus M2): Guard specified in both `ResolveDocument` and `VerifyOwnership` via `ensureCollabEligible(doc)` helper.
- **Large CSV guard** (opus L2): 10 MB text file size guard via `StorageTypeFromExtensionWithSize`.
- **file_type compat** (opus L1): `EnsureFileType()` sets `file_type = "binary"` for non-text files during transition.

## No Remaining Gaps

No issues from the prior reviews remain unaddressed at a level that would block implementation. The design is ready for phase decomposition.
