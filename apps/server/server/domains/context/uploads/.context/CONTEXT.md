# domains/context/uploads — thread upload import pipeline (work-scoped)

System-owned upload documents for chat and recent-document rails. Uploads are
context documents under the `uploads://<workId>/…` scheme (work-scoped,
ephemeral).

## What it owns

- **`uploads://` scheme** — per-Work upload target, replacing the hidden internal
  upload store. Scoped to a Work via `<workId>` authority.
- **`thread-upload-documents.ts`** — derives tracked-vs-binary storage behavior
  from canonical `Filetype` plus `documentFileTypeFor()`.
- **`ThreadUploadImportService`** — object bytes → internal upload document row
  → Yjs mirror seed for tracked files → thread attachment and recent-documents
  projection.
- **Internal backing source** — `thread_uploads`, provisioned by the context
  domain and registered in the public ContextPort router under `uploads://`.

## Invariants

- `DocumentFileType` is derived, not caller-authored. Use
  `documentFileTypeFor()` from `@meridian/contracts/protocol` for every upload
  classification.
- Binary object writes are cleaned up best-effort when later persistence or
  mirror-seeding steps fail.
- Tracked upload content is canonical in Yjs after import; markdown projection is
  the derived cache/search representation.
- Upload browsing requires work-scoped membership (membership gate, R4).
