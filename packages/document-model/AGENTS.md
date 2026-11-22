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
- Every reader goes through the read normalizer (`readDocument`, `readInline`, `StructureView`,
  `textUnits`), and every writer compares against it, so a merged state the schema forbids reads
  the same on every peer and a write-back emits nothing for it. Don't read the maps or a text's
  delta raw to decide what a document shows. Every text write goes through `replaceText`, which
  addresses shown units; the unstored empty paragraph is `derivedEmptyParent` / `isDerivedEmpty`
  for every writer.
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
