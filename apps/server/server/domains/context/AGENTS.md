# domains/context — context filesystem

Agent-readable and writable content behind context URIs: URI routing, catalog
views, arrivals and the storage seam. File access stays with
[file policy](../file-policy/.context/CONTEXT.md). Owners, schemes and the
rest of the contracts: [context contracts](.context/CONTEXT.md).

- `scratchOwnerFor(thread, work)` is the one owner rule for bare Scratch, in
  resolution and in file policy. `skills://` is model-only, not a context scheme.
- Routes and tools ask file policy before calling this domain. Storage
  transactions begin with `lockSeamWorks`, then the list's lock (`treeListStore.submit`), then
  namespace and document keys; lifecycle
  loss is reported as `context_unavailable`.
- Capabilities are declared in `ports/context-adapter.ts`. Uploads authority stays
  separate from `UploadIntake`; uploads are flat while Scratch accepts nested
  intake paths.
- Text creation and writes resolve filetype and use the collab document engine;
  never seed a Y.Doc with an assumed Markdown schema.
- A move writes no document content. Stable links re-spell on read, and every
  arrival settles ahead refs once against its final tree.
- A Copy (`copy/`) reads, plans names and binds refs before taking any lock, then
  submits one command into the destination's list. A source not yet caught up to the client answers `source_behind`, which is
  retryable and records nothing.
- The catalog and ContextFS read the same replay through a tree view. Every write of the
  tree (ContextFS, copy, upload, the model's tree tools) is records made in `treeListStore.submit`;
  the browser has no tree routes, and no write inserts a `documents` or `tree_nodes` row itself.
- Lineage hiding is reversible authority loss, not document deletion. Folder
  deletes validate the supplied folder identity before recursive mutation.

- The project tree's list (`@meridian/project-tree`) is stored by `adapters/drizzle-tree-list-store.ts`
  (port `ports/tree-list-store.ts`): one function admits a client's update or the server's
  records and writes `tree_nodes` / `branch_tree_nodes` in the same transaction. Nothing else
  writes those rows. Read [the tree list store](.context/tree-list-store.md) before touching it.

See also [tree](tree/AGENTS.md), [upload intake](uploads/.context/CONTEXT.md),
[collab](../collab/AGENTS.md) and [FUTURE](.context/FUTURE.md).
