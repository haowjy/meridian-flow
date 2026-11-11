# domains/context — context filesystem

Agent-readable and writable content behind context URIs: URI routing, catalog
views, arrivals and the storage seam. File access stays with
[file policy](../file-policy/.context/CONTEXT.md). Owners, schemes and the
rest of the contracts: [context contracts](.context/CONTEXT.md).

- `scratchOwnerFor(thread, work)` is the one owner rule for bare Scratch, in
  resolution and in file policy. `skills://` is model-only, not a context scheme.
- Routes and tools ask file policy before calling this domain. Storage
  transactions begin with `lockSeamWorks`, then namespace/source locks; lifecycle
  loss is reported as `context_unavailable`.
- Capabilities are declared in `ports/context-adapter.ts`. Uploads authority stays
  separate from `UploadIntake`; uploads are flat while Scratch accepts nested
  intake paths.
- Text creation and writes resolve filetype and use the collab document engine;
  never seed a Y.Doc with an assumed Markdown schema.
- A move writes no document content. Stable links re-spell on read, and every
  arrival settles ahead refs once against its final tree.
- A Copy (`copy/`) reads, plans names and binds refs before taking any lock, then
  locks only the destination namespace. A hidden draft node yields its name to a
  copy. A source not yet caught up to the client answers `source_behind`, which is
  retryable and records nothing.
- The catalog and ContextFS use the same tree view. Branch-hidden rows never
  escape it; Apply and Discard reconcile tree changes inside their own completion
  transactions.
- Lineage hiding is reversible authority loss, not document deletion. Folder
  deletes validate the supplied folder identity before recursive mutation.

See also [tree](tree/AGENTS.md), [upload intake](uploads/.context/CONTEXT.md),
[collab](../collab/AGENTS.md) and [FUTURE](.context/FUTURE.md).
