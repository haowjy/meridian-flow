# Filesystem Layer — Architecture Review

**Reviewer**: opus (architecture focus)
**Date**: 2026-04-05
**Inputs**: `filesystem-layer.md`, `docsystem-audit.md`, `decisions.md` (D29–D36), existing `docsystem` domain code

## Overall Assessment

The design is architecturally sound. The text/binary split along the DB/bucket boundary is the right call — it follows the grain of the existing system (Yjs state already lives in DB) rather than fighting it. The ISP preservation (Reader/Writer/Searcher/PathResolver) is correct and becomes more valuable with the binary file addition. The dataset domain collapse is a significant simplification win.

There are five issues worth addressing before implementation — one high-severity data integrity gap, two medium design concerns, and two minor edge cases. None require fundamental rearchitecture.

---

## Findings

### H1: Finalize failure leaves orphaned bucket files (data integrity)

**File**: `filesystem-layer.md` — Upload Flow, Binary file upload sequence diagram

The upload flow is: (1) create DB row with `status: uploading`, (2) generate pre-signed URL, (3) client uploads to bucket, (4) client calls `/finalize`, (5) backend verifies bucket file and updates DB row to `status: ready`.

**The problem**: If the finalize endpoint succeeds on the bucket verification (step 5, `GetFileInfo`) but the DB update fails (network error, constraint violation, transaction timeout), the bucket file exists but the DB row is stuck in `uploading` status. The system is now inconsistent: storage is consumed but the file isn't usable.

The reverse case is less dangerous — if the client never calls finalize (closes tab, network drop), you have a DB row in `uploading` status and possibly a bucket file. But the finalize failure is worse because the user thinks the upload completed (they got a 200 from the bucket PUT).

**What to do**:
1. The finalize endpoint should update the DB row inside a transaction and return success only after the DB commit. If the DB update fails, return an error — the client can retry finalize (it's idempotent if you use `UPDATE ... WHERE status = 'uploading'`).
2. Add a cleanup sweep (cron or on-demand) that finds DB rows in `uploading` status older than N hours. For rows where the bucket file exists, retry finalize. For rows where the bucket file doesn't exist, delete the DB row. This handles both client abandonment and finalize failures.
3. Document the consistency model: the DB is the source of truth. A bucket file without a `ready` DB row is garbage-collectible. A `ready` DB row without a bucket file is a bug (should never happen if finalize verifies existence first).

The bulk finalize endpoint (`/finalize-bulk`) has the same issue at larger scale — a partial batch failure could leave some files finalized and others orphaned. Consider making the bulk finalize transactional (all-or-nothing) or at minimum returning which document IDs succeeded and which failed.

### M1: Extension allowlist doesn't handle compound extensions (.nii.gz, .tar.gz)

**File**: `filesystem-layer.md` — Storage Routing, `StorageTypeFromExtension`

The routing function calls `strings.ToLower(ext)` and looks up the extension in `textExtensions`. But the design lists `.nii.gz` as a binary example. Go's `filepath.Ext("scan.nii.gz")` returns `.gz`, not `.nii.gz`. The lookup for `.gz` isn't in the text allowlist, so it falls through to binary — which happens to be correct for `.nii.gz`.

**Where this becomes a problem**: If someone uploads `data.csv.gz` (gzipped CSV), it routes to binary because the extension is `.gz`. That's arguably correct (compressed files are binary), but it's a behavior the design doesn't explicitly address. More importantly, the `Extension` field on the Document model would store `.gz`, losing the `.csv` semantic. The tree would show `data.csv.gz` (from `Name + Extension`) only if `Name` is `data.csv` and `Extension` is `.gz`, but the current `NormalizeExtension` doesn't handle this case.

**What to do**: Document the compound extension behavior explicitly. Either:
- (a) Accept that `filepath.Ext` governs and compound extensions route by their final segment (simple, predictable), or
- (b) Add a `compoundExtensions` map for known compounds (`.nii.gz`, `.tar.gz`, `.tar.bz2`) that checks `strings.HasSuffix` before falling back to `filepath.Ext`.

Option (a) is fine for MVP since all compound extensions in the biomedical domain (`.nii.gz`, `.dcm.gz`) are binary anyway. But document the decision so the implementer doesn't discover it by accident.

### M2: DocumentResolver collab gate needs explicit storage_type check

**File**: `collab/resolver.go` — `DocumentResolverAdapter.ResolveDocument`

The current `ResolveDocument` fetches a document by ID and returns a `CollabDocRef` with no type check. The design says "Gates on `StorageTypeText` — binary files cannot open collab sessions." But the audit says this is just an implementation guard to add, and the interface doesn't change.

**The concern**: The design places the binary-file guard in `ResolveDocument`, but `VerifyOwnership` is described as "the only active path" (Phase 1 comment in the code). If `VerifyOwnership` doesn't also gate on storage type, a code path that calls `VerifyOwnership` without first calling `ResolveDocument` could allow a binary file into a collab session.

Looking at the existing code, the collab session creation flow likely calls `VerifyOwnership` to check access, then proceeds to create a Yjs session. If it doesn't call `ResolveDocument` first, the storage type check never fires.

**What to do**: Put the guard in both methods, or better, extract it into a private helper:

```go
func (r *DocumentResolverAdapter) ensureCollabEligible(doc *domaindocsys.Document) error {
    if doc.StorageType != domaindocsys.StorageTypeText {
        return fmt.Errorf("document %s is binary (storage_type=%s), collab not supported", doc.ID, doc.StorageType)
    }
    return nil
}
```

Call it from both `ResolveDocument` and `VerifyOwnership`. Belt and suspenders — the cost is one extra DB field in the query, the benefit is defense in depth against future code paths that bypass `ResolveDocument`.

### M3: StorageService interface may be too thin — missing batch download URLs

**File**: `filesystem-layer.md` — Interface Changes Summary, `StorageService`

The `StorageService` interface has `GenerateUploadURL` (single) but the HTTP endpoints include `/bulk-upload-urls`. The interface doesn't expose a batch upload URL method. Either the handler loops over `GenerateUploadURL` (N round-trips to Supabase for N files in a DICOM stack — could be 400 calls), or the bulk endpoint bypasses `StorageService` and calls the SDK directly.

Similarly, there's no batch download URL generation. The sandbox copy-on-start flow needs to "generate signed download URLs (batch)" but has no interface method for it.

**What to do**: Add batch methods to `StorageService`:

```go
GenerateUploadURLs(ctx context.Context, projectID string, files []BulkUploadRequest) ([]BulkUploadResult, error)
GenerateDownloadURLs(ctx context.Context, projectID string, documentIDs []string) ([]BulkDownloadResult, error)
```

This keeps the service layer as the single abstraction over bucket operations (SRP) and allows the implementation to optimize (e.g., parallel URL generation, connection reuse). Without this, the handler or the Daytona service will end up with direct SDK calls, fracturing the storage abstraction.

### L1: `file_type` CHECK constraint drop timing

**File**: `filesystem-layer.md` — Database Schema, Migration

The migration adds `storage_type` and its CHECK constraint, then later says "The `file_type` column stays temporarily for backwards compatibility." Decision D33 notes the constraint must be dropped before binary files can be created.

The migration SQL drops the `file_type` CHECK constraint (`DROP CONSTRAINT IF EXISTS`). But the `EnsureFileType()` method on Document still calls `FileTypeFromExtension()`, which defaults unknown extensions to `FileTypeMarkdown`. So a `.dcm` file would get `file_type = "markdown"` — nonsensical but not a runtime error since the CHECK constraint is dropped.

**What to do**: During the transition, `EnsureFileType()` should set `file_type` to a sensible default for binary files (e.g., empty string, or a new `"binary"` value). Or skip calling `EnsureFileType()` entirely for binary documents. The current default-to-markdown behavior is a data quality issue that will confuse anyone querying the `file_type` column during the migration window.

### L2: Large CSV files stored as text in DB

**File**: `filesystem-layer.md` — Storage Routing, `textExtensions`

`.csv` and `.tsv` are in the text allowlist. The design comment says "tabular (small enough for DB)." But CSVs in biomedical research can be enormous — genomics data, measurement series, etc. A 200 MB CSV in a TEXT column is technically valid in Postgres but will cause pain: full-row reads load the entire content into memory, backups slow down, and TOAST compression has limits.

**What to do**: This is acceptable for MVP with a documented file size check. The upload flow should validate: if storage_type resolves to `text` but the file exceeds a threshold (e.g., 10 MB), either reject with an error suggesting the user upload as binary, or automatically override to binary storage. This prevents the "someone uploads a 500 MB CSV and it goes into a TEXT column" scenario.

---

## What the design gets right

- **Binary-default allowlist**: D30 is the correct call. Unknown extensions in a TEXT column is a data bomb. Unknown extensions in a bucket is harmless.
- **ISP preservation**: D32 correctly identifies that the Reader/Writer/Searcher/PathResolver split becomes *more* valuable with binary files. The collab domain depending on `DocumentReader` (not `DocumentStore`) is clean isolation.
- **Dataset domain collapse**: D31 eliminates ~500 lines of parallel infrastructure. "Dataset = folder with metadata" is the right abstraction.
- **Service-layer orchestration for deletes**: The audit's recommendation to keep DocumentWriter DB-only and orchestrate bucket cleanup at the service layer is correct SRP.
- **Bucket organization by document ID**: Decoupling the bucket path from the user-visible file path (rename/move = DB update only) is the right design for a mutable tree.
- **Sandbox access via S3 API**: D34's rejection of FUSE for DICOM seek patterns is well-evidenced.

## Verdict

**Approve with notes.** H1 (finalize failure consistency) should be addressed in the design before implementation — it's a data integrity gap that will bite in production when uploads happen over unreliable networks. M2 (collab gate) and M3 (batch methods) should be addressed during implementation. M1, L1, and L2 are worth documenting as implementation notes.

No fundamental rearchitecture needed. The design is ready for implementation planning.
