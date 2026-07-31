# domains/context/uploads — thread upload import pipeline (work-scoped)

Thread-attached files and recent-document rail projections. Attachments are
ordinary context documents under the primary Work's `uploads://<workId>/…`
scheme.

## What it owns

- **`ThreadUploadImportService`** — multipart bytes → the thread's primary Work
  ContextPort → `thread_documents` attachment.
- **`thread-upload-documents.ts`** — reads attached context documents for the
  upload rail, recent-document rail, downloads, and runtime image resolution.
- **`thread-upload-delete-service.ts`** — verifies the attachment, then
  soft-deletes its current authoritative URI through `ContextPort.delete`.

## Invariants

- `DocumentFileType` is derived, not caller-authored. Use
  `documentFileTypeFor()` from `@meridian/contracts/protocol` for every upload
  classification.
- Binary object writes are cleaned up best-effort when later persistence or
  context-document or attachment steps fail.
- Tracked content enters through `ContextPort.createTrackedDocument`; binary
  content enters through `ContextPort.writeBinary`. There is no parallel upload
  document store.
- The original basename is preserved. An occupied `name.ext` advances to
  `name-2.ext`, then `name-3.ext`, deterministically within the Work.
- `thread_documents` is provenance and the rail index. Deleting the context
  document does not erase that provenance row, but active rail queries no
  longer return the soft-deleted document.
- Runtime image references must match the attached document's canonical
  `uploads://<workId>/path`; attachment alone is not a substitute for URI
  validation.
