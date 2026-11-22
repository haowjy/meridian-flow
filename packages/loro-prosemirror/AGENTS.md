# @meridian/loro-prosemirror

Our binding of ProseMirror to the document shape in `@meridian/document-model`. Design:
`loro-build/design.md` §6 in the docs repository.

- Between transactions the editor's document is what the docs read as (`readProseMirror`). Start
  an editor's state from that read, and keep it true: every local write is computed against it.
- Import a peer's batch with `importRemoteUpdate`, never `RoomDocs.importBatch` or `doc.import`.
  It holds the batch while an editor on the room is composing (an import mid-composition doubles
  or drops the composed text) and forwards a Live batch into the room's open drafts.
- Every block the editor hands the binding has a unique `id`. The app's block-id fixer gives a
  split or a paste its ids inside the same transaction; the binding throws on a missing or
  duplicate id rather than inventing one.
- Two comments on the same text are two style keys, `comment_<id>`; `marksOf` orders marks the
  same on every peer.
- Typing (one replace of inline content inside one textblock) goes through `replaceText` on that
  block's text doc alone; any other change goes through `writeDocument`. `replaceText` writes a
  style op only where Loro's stored style differs from the editor's, so typing inside a mark is
  one op.
- Destroy the `EditorView` before freeing its `RoomDocs`: destroying it releases held batches into
  docs still alive.

Not yet mounted: phase 1c adds the app's mount, Ctrl+Z on `onLocalWrite`'s doc changes, cursors
in the UI and the caret rule for a block a peer removed. Probe:
[round-trip](.context/qa/round-trip.md).
