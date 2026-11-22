# @meridian/document-model

A Meridian document as Loro docs, shared by the browser, the server and agent-edit. Design:
`loro-build/design.md` §1 and §4 in the docs repository.

- A document room holds one structure doc (value maps `parent`, `order`, `node`, `attrs`,
  `comments`, keyed by block id) and one text doc per textblock, keyed by its block id
  (`RoomDocs`). A draft's fork writes only the `d.*` override maps and its own forks of the text
  docs it wrote; it reads Live's text for every other block. Never write a base map from a fork:
  `StructureWriter` is the one writer of structure values.
- Every `LoroDoc` is WASM memory no garbage collector frees. Whoever creates a `RoomDocs`
  (`create`, `load`, `draftOf`, `fork`, `at`, `DocumentRooms.read`) calls `free()` on it; any use
  after that throws `RoomDocsFreedError`. In the browser, destroy the `EditorView` first, then free
  its docs. A planning view at a read's frontiers is `docs.at(docs.frontiers())`, not a raw
  `forkAt`: it works after the history cutoff and frees like any copy. Export its writes with
  `view.exportSince(docs.shownVersion())`; the view's own `version()` ships a block it forked from
  Live with that block's whole history.
- Every container, version vector and cursor Loro returns is a WASM handle that no garbage
  collector frees: use it inside `scoped`, `inText`, `inMap` or `inVersion` (`handles.ts`) and never
  keep one past its call. Hold a version as bytes (`RoomDocs.encodedVersion()`, `encodedVersionOf`),
  not as `version()`'s vectors, which the caller must `freeVersion`; `DocCursor` holds a cursor's
  bytes. Run the two-editors probe with `HANDLES=1` after touching code that makes handles: it
  names any left unfreed.
- Every reader goes through the read normalizer (`readDocument`, `readInline`, `StructureView`,
  `textUnits`), and every writer compares against it, so a merged state the schema forbids reads
  the same on every peer and a write-back emits nothing for it. Don't read the maps or a text's
  delta raw to decide what a document shows. Every text write goes through `replaceText`, which
  addresses shown units; the unstored empty paragraph is `derivedEmptyParent` / `isDerivedEmpty`
  for every writer, and only when it is its container's one block (`storedOf`). A local write
  into a text doc takes the doc from `writableText`, which tells `beforeTextWrite` listeners
  first: the editor's Undo starts its Loro `UndoManager` for the doc there.
- `writeDocument`'s `previous` and `readDocument`'s `since` make a write or a read cost what
  changed: a block that is the same object as in `previous` (under the same parent) is not
  compared, and a read keeps `since`'s object for every block that reads as it did. Pass them
  only with what the docs read as now; with neither, both work on the whole document.
- A removal is a record in `order[id]`, JSON text of `{ at, seen }`: the key the block had and the
  version (`{ peer: counter }`) the remover read of every text doc under it. `StructureWriter.remove`
  is its one writer, on the topmost removed block only. What shows is the structure doc's alone: a
  block shows when its `order` is a key (`isOrderKey`, a first-character test; no read parses a
  record) and its ancestors show. A removed block comes back only by a write of its key:
  `restore`, Undo's replay, or rule 1, `answerRemovals(docs, before)`, which every copy that imports
  (each tab, the server's room) runs after an import that changed the structure and before any
  reader. `removals.ts` holds the rule's functions; `UNTRACKED_ORIGIN` commits keep them out of
  every Undo history. Never move the record into a second map: an Undo can then delete it while
  another peer's removal stands.
- A batch is an envelope of `(docKey, bytes)` (`encodeEnvelope`); a room's version is the same
  shape with version vectors (`encodeRoomVersion`). Import and acknowledge a batch as one:
  `importBatch` and `load` check every entry before touching any doc, so bytes that aren't Loro's
  (`CorruptDocBytesError`) or an update below a doc's shallow cutoff (`HistoryCutoffError`)
  import nothing.
- Each writer takes a fresh peer id (`freshPeerId`, `freshServerPeerId`); a copy uses its one
  peer across all its docs.
- No ProseMirror at runtime: callers pass a `ShapeSchema`, which `@meridian/loro-prosemirror`'s
  `shapeSchemaOf` builds from the schema.

`./rooms` is the server's one door to a document room (`DocumentRooms`) and its in-memory
adapter, which keeps the door's orderings but saves only on `flush` and `unload`. The hand-run
probe that exercises this package with the binding is
[round-trip](../loro-prosemirror/.context/qa/round-trip.md).
