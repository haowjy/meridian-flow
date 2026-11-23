# @meridian/loro-prosemirror

Our binding of ProseMirror to the document shape in `@meridian/document-model`. Design:
`loro-build/design.md` §6 in the docs repository.

- Between transactions the editor's document is the docs' read plus the removed blocks it keeps
  for its caret (`readProseMirror` with `LoroSyncState.kept`, almost always empty). Start an
  editor's state from the read, and keep it true: every local write is computed against it, and
  every read or write the binding makes while blocks are kept passes them (`kept`).
- Import a peer's batch with `importRemoteUpdate`, never `RoomDocs.importBatch` or `doc.import`.
  It holds the batch while an editor on the room is composing (an import mid-composition doubles
  or drops the composed text), and forwards a Live batch into the room's open drafts. The import
  answers a removal the batch brings that did not read this copy's typing before any editor reads
  it; the caller's `publish` sends that restore, and a draft's forward restore goes out through
  the `publish` its editor registered (`listenToImports`).
- Every block the editor hands the binding has a unique `id`. The app's block-id fixer gives a
  split or a paste its ids inside the same transaction; the binding throws on a missing or
  duplicate id rather than inventing one. The one id the binding changes is an empty container's
  placeholder `<container>/empty`: its `filterTransaction` gives a node holding one a fresh id
  (`newBlockId`, from the caller) once it is anything but that container's one empty paragraph,
  so the docs never store a placeholder id (`writeDocument` throws if one would be). It runs
  before or after the fixer's filter alike: the fixer never gives a placeholder id, and a renamed
  node is unclaimed by any other. Typing into a placeholder is still typing for the history: the
  write stores the paragraph, and the burst stays one Undo step. An editor whose node view rebuilds
  a textblock on any attribute change breaks an IME composition at that rename: the app's
  paragraph view keeps its element.
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
  `UndoManager` per text doc the copy writes, and editor steps over them. Don't build a text
  inverse of our own: Loro's manager keeps inverses as positions carried through later edits,
  which is what a chain of dependent steps needs (design §6). A manager records only commits
  made after it exists, so it is created at the doc's first write (`RoomDocs.beforeTextWrite`);
  every local write into the copy that no Ctrl+Z should take back commits under
  `UNTRACKED_ORIGIN`, or it becomes an item that blocks the steps below it on that doc.
  `destroy()` the history before freeing the docs: each manager is WASM memory.
- The structure doc has no manager. A step goes back whole or stays whole (design §2, "An Undo
  takes an edit back whole"): `UndoHistory` keeps what each step did as a `document-model`
  `Edit` (structure values, text spans, what its next run takes off or brings onto the screen)
  and runs a step only while `editStays` finds nobody else wrote over it; `putBackValues` then
  writes its values back, a block it made going as a removal. That rule is `document-model`'s
  (`take-back.ts`), shared with the press's Undo: change it there, not here. A step that stays
  writes nothing: the managers of its text docs are made again, so it and every step sharing a
  doc or a structure key with it leave the history (Loro can't drop one item). "Someone else" is
  another peer: this copy's own untracked writes never keep a step. The history keeps steps
  (500), not manager items: a manager has no item limit, since one typing step split by a peer's
  batches is an item per key, and a limit would drop part of it. Typing joins the open step; any
  other write starts one, and a write that sets structure ends it. A step's note is taken late, just before the next import
  (`RoomDocs.beforeImport`), the next write that is not typing (sharing that write's read of the
  structure), or a run: an Enter pays one read of the structure, not two.
- Every Undo and Redo commit in a text doc carries `takeBackMessage` (what each character it puts
  back stands for, `deletedBetween` of the step's span), set in `subscribePreCommit`: `textSince`
  reads text it put back as the text it deleted.
- The caret rule (design §1, "Removed blocks"): when a peer's batch removes the block holding the
  selection's head, or a block above it, the editor keeps every removed block on that path in its
  document. A local transaction with a step inside a kept block restores them (`restore`, which
  publishes) and then writes as usual; any other write leaves them removed in the docs. The head
  leaving them ends it, and `appendTransaction` reads them off the screen. A local import
  (`notifyChanged`: an Undo, a command) keeps nothing new.
- Destroy the `EditorView` before freeing its `RoomDocs`: destroying it releases held batches into
  docs still alive.

Probes: [round-trip](.context/qa/round-trip.md), [two-editors](.context/qa/two-editors.md).
