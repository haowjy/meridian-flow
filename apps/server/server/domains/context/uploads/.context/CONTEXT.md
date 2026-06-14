# domains/context/uploads — thread upload import pipeline

System-owned upload documents for chat and recent-document rails. Uploads are
context documents, but they are hidden from public `kb://`, `work://`, and
`user://` trees.

## What it owns

- **`thread-upload-documents.ts`** — derives tracked-vs-binary storage behavior
  from canonical `Filetype` plus `documentFileTypeFor()`.
- **`ThreadUploadImportService`** — object bytes → internal upload document row
  → Yjs mirror seed for tracked files → thread attachment and recent-documents
  projection.
- **Internal backing source** — `thread_uploads`, provisioned by the context
  domain and intentionally not registered in the public ContextPort router.

## Invariants

- `DocumentFileType` is derived, not caller-authored. Use
  `documentFileTypeFor()` from `@meridian/contracts/protocol` for every upload
  classification.
- Binary object writes are cleaned up best-effort when later persistence or
  mirror-seeding steps fail.
- Tracked upload content is canonical in Yjs after import; markdown projection is
  the derived cache/search representation.
