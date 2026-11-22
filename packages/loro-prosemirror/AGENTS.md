# @meridian/loro-prosemirror

Our binding of ProseMirror to the document shape in `@meridian/document-model`. Design:
`loro-build/design.md` §6 in the docs repository.

- Between transactions the editor's document is the docs' read plus the removed blocks it keeps
  for its caret (`readProseMirror` with `LoroSyncState.kept`, almost always empty). Start an
  editor's state from the read, and keep it true: every local write is computed against it, and
  every read or write the binding makes while blocks are kept passes them (`kept`).
- Import a peer's batch with `importRemoteUpdate`, never `RoomDocs.importBatch` or `doc.import`.
  It holds the batch while an editor on the room is composing (an import mid-composition doubles
  or drops the composed text), forwards a Live batch into the room's open drafts, and answers a
  removal the batch brings that did not read this copy's typing (`answerRemovals`) before any
  editor reads it; the caller's `publish` sends that restore.
- Every block the editor hands the binding has a unique `id`. The app's block-id fixer gives a
  split or a paste its ids inside the same transaction; the binding throws on a missing or
  duplicate id rather than inventing one.
- Two comments on the same text are two style keys, `comment_<id>`; `marksOf` orders marks the
  same on every peer.
- Typing (one replace of inline content inside one textblock) goes through `replaceText` on that
  block's text doc alone; any other change goes through `writeDocument`. `replaceText` writes a
  style op only where Loro's stored style differs from the editor's, so typing inside a mark is
  one op.
- A change costs what it touches, by identity. The codec maps each ProseMirror node to its
  `ShapeBlock` and back (`blocksOf`, `nodeOf`), so a node a transaction left alone is the block it
  was. A write passes the transaction's starting document as `previous` and compares only the
  blocks that are new objects; a remote batch is read with `since` (the editor's document, the
  comments it showed bodies of, the doc keys the batch changed) and keeps every other node. Both
  lean on the invariant above: a `previous` or `since.doc` that is not what the docs read as
  writes or shows the wrong thing.
- Ctrl+Z is `UndoHistory` (`history.ts`), passed to the plugin as `history`: one Loro
  `UndoManager` per doc the copy writes, and editor steps over them. Don't build an inverse of our
  own: Loro's manager keeps inverses as positions carried through later edits, which is what a
  chain of dependent steps needs (design §6). A manager records only commits made after it
  exists, so it is created at the doc's first write (`RoomDocs.beforeTextWrite`); every local
  write into the copy that no Ctrl+Z should take back commits under `UNTRACKED_ORIGIN`, or it
  becomes an item that blocks the steps below it on that doc. `destroy()` the history before
  freeing the docs: each manager is WASM memory.
- The caret rule (design §1, "Removed blocks"): when a peer's batch removes the block holding the
  selection's head, or a block above it, the editor keeps every removed block on that path in its
  document. A local transaction with a step inside a kept block restores them (`restore`, which
  publishes) and then writes as usual; any other write leaves them removed in the docs. The head
  leaving them ends it, and `appendTransaction` reads them off the screen. A local import
  (`notifyChanged`: an Undo, a command) keeps nothing new. After an Undo or Redo run changes the
  structure, `UndoHistory` writes again every removal record the run replayed
  (`restampRemovals`), in the run's batch.
- Destroy the `EditorView` before freeing its `RoomDocs`: destroying it releases held batches into
  docs still alive.

Probes: [round-trip](.context/qa/round-trip.md), [two-editors](.context/qa/two-editors.md).
