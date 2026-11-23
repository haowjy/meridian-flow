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
- Every container and cursor Loro returns is a WASM handle that no garbage collector frees: use it
  inside `scoped`, `inText` or `inMap` (`handles.ts`) and never keep one past its call; `DocCursor`
  holds a cursor's bytes. Versions are plain values (`version.ts`, below). Run the two-editors probe
  with `HANDLES=1` after touching code that makes handles: it names any left unfreed.
- Every reader goes through the read normalizer (`readDocument`, `readInline`, `StructureView`,
  `textUnits`), and every writer compares against it, so a merged state the schema forbids reads
  the same on every peer and a write-back emits nothing for it. Don't read the maps or a text's
  delta raw to decide what a document shows. Every text write goes through `replaceText`, which
  addresses shown units. The unstored empty paragraph an empty container or document shows has
  the placeholder id `<parent>/empty` (`emptyParagraphId`), which no block is ever stored under:
  the first write into it stores a paragraph under a fresh id (the binding renames the editor's
  node in the same transaction; `applyOps` takes `newBlockId`), so the id never leaves its parent
  and never names a removed block. `writeDocument` skips it only as its container's one empty
  block (`storedOf`, `isDerivedEmpty`), and throws if it would store a new block under one;
  `applyOps` addresses it through `derivedEmptyParent` and returns the fresh id it stored each
  placeholder under (`renamed`). A caller that goes on addressing the paragraph after the call
  must follow `renamed`: agent-edit moves the paragraph's ref onto the fresh id
  (`LoroDocument.apply`), or a later edit in the same command finds no block.
  Which blocks show is one function, `showRule`: `StructureView` runs it over every block and an
  Undo's test over the blocks its run changes. Don't write a second copy of it. A local write
  into a text doc takes the doc from `writableText`, which tells `beforeTextWrite` listeners
  first: the editor's Undo starts its Loro `UndoManager` for the doc there.
- `writeDocument`'s `previous` and `readDocument`'s `since` make a write or a read cost what
  changed: a block that is the same object as in `previous` (under the same parent) is not
  compared, and a read keeps `since`'s object for every block that reads as it did. Pass them
  only with what the docs read as now; with neither, both work on the whole document.
- A removal is a record in `order[id]`, JSON text of `{ at, seen }`: the key the block had and the
  `DocVersion` the remover's copy showed of every text doc under it (its state's, not its oplog's:
  a view checked out at a read holds ops it never showed). `StructureWriter.remove`
  is its one writer, on the topmost removed block only. A write that re-keys siblings never
  re-keys a removed block the editor keeps (`orderKeys`' `pinned`): a new key would bring it back. What shows is the structure doc's alone: a
  block shows when its `order` is a key (`isOrderKey`, a first-character test; no read parses a
  record) and its ancestors show. A removed block comes back only by a write of its key:
  `restore`, an Undo's `putBackValues`, or rule 1, which `RoomDocs.importBatch` and `forward` run on every
  import, before any reader: they return every answer the copy wrote (`Imported.answers`), and its
  holder sends and saves them like a local write (`encodeChanges`). They are the only ways ops enter
  a copy; never import into one of its docs directly. `removals.ts` holds the rule's functions; `UNTRACKED_ORIGIN` commits keep them out of
  every Undo history. Never move the record into a second map: an Undo can then delete it while
  another peer's removal stands.
- A batch is an envelope of `(docKey, bytes)` (`encodeEnvelope`); a room's version is the same
  shape with version vectors (`encodeRoomVersion`). In code a version is plain peer counters
  (`DocVersion`, `RoomVersion`, `version.ts`), never a Loro `VersionVector`: a vector is WASM
  memory too, and versions are read on every batch, so one that escapes leaks per keystroke for
  the life of a tab or the server. A function that needs a vector makes it with `withVector` or
  reads one out with `plainVersion`, which free it. Import and acknowledge a batch as one:
  `importBatch` and `load` check every entry before touching any doc, so bytes that aren't Loro's
  (`CorruptDocBytesError`) or an update below a doc's shallow cutoff (`HistoryCutoffError`)
  import nothing.
- Every Undo, the editor's Ctrl+Z and a press's, follows one rule (`take-back.ts`, design §2 "An
  Undo takes an edit back whole, or leaves it whole"): `editStays` tests an `Edit` (`valuesOf`,
  its text spans, `noteEdit` after each write or run and before the next import), and only then
  does the caller take its text back and `putBackValues` write its structure. Don't add a second
  test beside it. "Someone else" is any peer but `Edit.peer`, the edit's author, never the copy's
  peer: a press's Undo runs on a server copy with a peer of its own. An edit's ops in a text doc are
  its span's (`TextSpan.ops`): the author's in the editor, every peer's for a press, which imports
  its draft's ops. Every commit message is `commit-message.ts`'s, one JSON note: who wrote it
  (`by`: a turn or a press; none is the writer), and for a commit that puts text back the
  character each one it inserts stands for and the ops it takes back (`undo: { for:
  deletedBetween(doc, before, after), ops: span.ops }`). So `textSince` reads put-back text as the
  text it deleted, by character id, `editStays` counts ops an Undo took back as never made
  (`standingSince`: a delete, and typing in a block the run would take away), and attribution
  still reads who took it back. The rule and the runner that takes the edit back must agree on
  "whole": a press's inverse deletes text an Undo put back for the press's characters
  (`putBackOf`), but Loro's manager, which runs a Ctrl+Z step, deletes only the step's own
  characters, so a step carries `Edit.ownTextOnly` and part 4 reads put-back text as deleted for
  it. Read the message before the write: a fork of the doc commits its pending ops, without the
  message.
- Each writer takes a fresh peer id (`freshPeerId`, `freshServerPeerId`); a copy uses its one
  peer across all its docs. A draft copy's own Live copy takes another, which the `RoomDocs`
  constructor enforces: a press writes both rooms from one copy, and one peer would mint the same
  op ids in both.
- The block-change model (`changes.ts`, `invert.ts`; design §2) works on a draft copy and forwards
  it first. `changedBlocks` groups what differs from Live into changes: blocks under an inserted or removed
  container, and blocks a write moved text between, by the `d.pieces` record that write made
  (`WriteOptions.pieces`, the `pieces` op; one key per write, `<a>/<b>/<peer>@<counter>`, so
  recording a pair again always writes an op and a press deletes only the keys it read). The
  writer of a split or a join says which blocks they are; nothing here compares two texts to
  guess. Records form a graph: changed blocks connected in it are one change. A record lives only
  while its component holds a changed block: every draft write retires the components it touched
  that hold none (`retirePieces`, in the write's own commit, so its Undo brings them back), and a
  press deletes the components of the blocks it settles, so a clean draft holds no records. A block that is not
  a change (hidden on both sides, or reading as Live's again) only connects its neighbours and is
  never a member, so a press writes none of its overrides into Live. It runs on every fork save
  and Live batch, so it reads only blocks the fork holds text or an override for (a block with
  neither reads as Live's), plus Live's carriers of a comment body the fork changed. `applyBlocks`
  imports the fork's text into Live and writes the chosen overrides there, a removal as a new
  record stamped with the Live version the writer was shown (`liveVersion`; a text doc it lacks
  counts as never shown);
  `discardBlocks` makes the fork take Live's. Run each on a command's own copy, so the press's
  writes have peers no later write shares. Each returns, per change, the edit it made in each room
  (`PressedChange`, JSON for `press_changes`), noted as the press left the room: the note can't be
  taken later. `undoPress` tests each change with `editStays`, its Live and fork sides as one edit,
  and leaves one someone wrote over (`PressUndo.stayed`); `takeBack` writes the rest, Live's
  first, each text doc by its inverse moved through `textSince` (`transformedInverse`; a change
  that goes back goes back whole, as Ctrl+Z's does) before `putBackValues`, so a removal record put back counts the text; then the fork is returned
  to pending. A press over several drafts is undone one draft at a time, newest first.
  `restoreBefore` puts a turn's overrides back key by key through `putBackValues`, keeping a key
  written since. A forward's restore is not a write of the press. The hand-run fuzz is
  [block-changes-fuzz](../loro-prosemirror/.context/qa/block-changes-fuzz.md); run it at 10,000
  seeds after changing any of this.
- No ProseMirror at runtime: callers pass a `ShapeSchema`, which `@meridian/loro-prosemirror`'s
  `shapeSchemaOf` builds from the schema.

`./rooms` is the server's one door to a document room (`DocumentRooms`) and its in-memory
adapter, which keeps the door's orderings but saves only on `flush` and `unload`. The hand-run
probe that exercises this package with the binding is
[round-trip](../loro-prosemirror/.context/qa/round-trip.md).
