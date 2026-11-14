# domains/context/tree

Contract: [local contract](.context/CONTEXT.md). The writer of the tree's rows:
[the list store](../.context/tree-list-store.md).

- Nothing here writes `tree_nodes`, `branch_tree_nodes` or a document's name or place: the
  store's replay does, in the transaction that admits the records. A change to the tree is a
  record made with `TreeListStore.submit`.
- Readers take a `TreeView` and compose `visibleDocuments(view)` and `visibleFolders(view)`
  (`tree-relations.ts`). Nothing filters a hidden or tombstoned row, because there is none.
- Lock order: Work rows, the tree list's key, then document keys in sorted order, then draft
  rows. Take the list first when a path needs a list and documents.
- A node's `name` is its filename as shown, extension included. Never build a filename with
  `renderFilename(name, extension)`; the stem and extension of a name come from
  `parseDocumentFilename` where a caller needs them (export).
- A document's owner is `documents.project_id`. Its source, folder, name and type come from a
  view's relations; `loadDocumentPlacement` reads them from any row that places it.
- Path walks go one level at a time with `LATERAL ... OFFSET 0` probes (`nodesAt` in
  `tree-view.ts`); a folder chain is `loadFolderChains(db, ids, view)`.
- A document in no view (in Trash, or its drafted create was discarded) is readable by the server
  only. Retention releases its content after the window (`drizzle-document-trash.ts`).
