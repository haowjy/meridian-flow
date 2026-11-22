# agent-edit — contracts and architecture

Read the page that owns the seam you are changing:

- [Port contracts](port-contracts.md): what a host must do that the port types can't say.
- [Write architecture](write-architecture.md): planning, capture, targeting and results.
- [Link identity](link-correspondence.md): ref assignment at every write door.
- [Diff](diff.md): the block diff, block correspondence and the Yjs block writer.
- [Content merge](content-merge.md): the three-way block merge and what an AI edit's change is in a text now: its rules, repairs, rescues and known losses.

Deferred work is in [TODO.md](TODO.md) and [FUTURE.md](FUTURE.md); rejected
directions are in [ALTERNATIVES.md](ALTERNATIVES.md).

## Pinned reconstruction adapter

Several files read Yjs struct internals, among them `frontier.ts`, `model/block-hash.ts`,
`undo/receipt.ts` and `diff/`, which is why `yjs` is exactly pinned in
`package.json`; check them all when the pin changes. `src/yjs-mutation.ts` holds the
mutation mechanics. Keep version-sensitive
reconstruction here rather than in app or undo copies. Hosts choose operations,
supply identity mapping and own transactions; the adapter copies an item's own
content, never its descendants.

## Schema repair

Building ProseMirror nodes from Yjs makes y-prosemirror delete any element the schema cannot
build. `model/schema-repair.ts` is the one place this package does that (`readRepairedRoot`,
used by `projectBlocks` and `readBlocks`), counts it per path (`schemaRepairCounts()`: `editor`,
`projectBlocks`, `readBlocks`; the browser witness reports the first) and recognises the
binding's delete when it arrives as a writer's update (`isSchemaRepairUpdate`), so the server
journals it with no actor. A new read of a fragment goes through `readRepairedRoot`, or its
repairs are not counted. A repair inside a caller's transaction (a capture, a write) is part of
that transaction's update: read before a capture starts.

## Reading blocks per change

A whole-fragment read walks every deleted item the document keeps (`gc: false`; a checkpoint
drops their content but keeps their ids), so it costs the document's history, not its text. Code that reads the document again after each of many small
changes (the suggestion model per block, a draft write's receipts per paragraph segment) reads
through `heldBlocks` (`diff/fragments.ts`): the first read converts the whole fragment, repairs
and all, and each transaction then forgets only the top-level blocks it changed, which the next
read converts alone from a copy. Yjs leaves a block created inside a transaction out of
`transaction.changed`, so inside a transaction a node is stored only for a block that existed
before it and that it has not changed yet; a node stored for any other could go stale for good. `readBlocks` per change makes a 100-paragraph write read the whole
document hundreds of times.

## Text runs

Adjacent `Y.XmlText` children of a block are one run of text, as in the patched
`@tiptap/y-tiptap` this package shares with the server and the browser (see the editor's
`.context/CONTEXT.md`). `applyOps` (`model/y-prosemirror.ts`) addresses units across a block's
texts, so an edit goes to the text that owns its offset and an insert at a boundary joins
the earlier one. Every walker of a block's children follows it: unit addressing skips empty
texts, which are zero units wide and share a unit with the atom after them. A read never writes to the
document.

## Block correspondence

`src/diff/correspond.ts` decides which old block is which new block. The content merge asks by
id (`byId`: [diff](diff.md#block-correspondence-by-id)). Everyone else asks in guess
mode, for every writer of a sequence of blocks: `resolver/block-alignment.ts` (the model's write),
`writeChildren` (the Yjs writer, at each level) and, inside a block, the writer's atoms
(breaks, images). Identity comes from content with attributes left out, chosen over the
whole run, so an attribute-only change (an indent) pairs a block with itself; blocks of
one type only, since an element cannot change type; a split or join is one unit rooted
at its first block, and its pieces are of that type too. The pairing is always one ordered
set: of blocks that cross (swapped paragraphs, a repeated line) one stays and the other is
deleted and inserted. A gap small enough to score whole pairs by shared words, and a weak
overlap beats none; blocks of one type that share nothing still pair by position there. A
larger gap is cut first at the pairs that clear the similarity bar (longest in-order
chain). A block's candidates come from a word index of its rarest words plus the blocks at its
place, counted from the gap's start, from its end and in proportion, so misleading rare words
never leave an edited block unpaired. Each piece between them is treated the same way. A piece
still too large pairs nothing new: never by position, never by weak overlap, and never does the
budget remove a pair the cut found. An unpaired block is deleted or inserted, and nothing else
rebuilds an element. Inside a block the model's write and the Yjs writer share one lowering
(`resolver/lower-block.ts`) and one adapter (`applyOps`): a container's children pair here
too (by id where they have ids), and text is word-diffed as units. The model's write carries no ids (it writes text), so its pairing is by
content only; the Yjs writer and `diffBlocks` pair by id.

What this keeps is the element, not every character's author: an image or break inserted
inside a text run copies the text after it into a new run, so those characters change
author and a peer's edit aimed at them can be lost. `main` rebuilt the whole paragraph
there; this is a rare case left as it is.

## Planning on what the model read

A write plans on the document as the model last read it, so a word the writer deleted after
that read stays deleted. That read has two sources:

- **The Yjs frontier** (`planningSnapshot`), the main one: the room copy at the frontier
  recorded with the read, plus the reply's own writes. It gives the whole document as read,
  including blocks the model saw only partly (an outline heading, a grep passage, an echo's
  opening words), so a writer's later edit anywhere in them survives.
- **The transcript** (`tool/read-view.ts`), only when a checkpoint has dropped content the
  frontier saw, so the frontier can't be rebuilt. Each block a stored result showed in full
  (`{hash, body}`, latest showing wins) is the base; the model's command applied to that base is
  ours; the room now is theirs; the three-way content merge writes the result as a
  whole-document replace. A rewrite of a block the room has deleted since answers `block_gone`
  with the current text, as on a usable frontier, since the merge would bring the block back. A shown hash counts only when it matches exactly one block visible at
  the frontier, so a block made since the read can't take a shown body by prefix. It covers a
  `replace` with content and no `find`; `insert` and `remove` can't bring deleted text back, and
  `find` matches the room as it is now.

The transcript isn't the main source, because a block it showed only partly has no base but
current Live: the model's text for it lands as a plain rewrite, and the writer's later edits
there are overwritten. That is also what the fallback still loses: a block with no full showing
whose writer edit came after the read. The concurrent listing can't name who made an edit since
a collected read either (it needs the read's document), so it says `unknown`.

## The Loro core

`tool/loro-write.ts` (`createLoroEditCore`) runs `read` and `write` on a room's Loro docs
(`AgentEditRooms.readRoom`, one `RoomDocs` per call, freed at the call's end). What differs from
the Yjs core:

- **Block identity is the block id.** Hashes are `fullHashForBlockId(id)`'s unique prefixes, and
  `ProjectedBlock.key` / `BlockSnapshot.key` carry the id (the Yjs model fills them with its item
  id), so echo, receipts and links share one path for both cores.
- **Planning is a view.** The read's frontier is a per-doc map (`loro-frontier.ts`,
  `encodeFrontierMap`), the reply's own batches merged in by their end version; the write plans
  on `docs.at(frontiers)`, exports one batch (`exportSince(shownVersion())`) with the commit
  message `turn:<turnId>` and saves it through `rooms.save` with an `AgentWriteRecord` whose
  `delta` (`captureDelta`) is what Undo takes back by content (`takeBack`). A frontier below the
  history cutoff falls back to the transcript as above (`transcriptMerge`).
- **Who changed what** (`tool/loro-observation.ts`) comes from the docs that changed since the
  recorded frontier and their commit messages: `turn:<id>` is a chat (`authorOfTurn`), the
  reader's own turn is skipped, and no message is the user. A structure change credits every
  author of the structure doc since the read with every structural change: coarse, never wrong
  about who touched the document.
- Lineage is empty (no semantic IR scope), and a block deleted since a read that fell back to
  the transcript answers `not_found` with the current text, not `block_gone`.

The Yjs-only code (`frontier.ts`, `yjs-mutation.ts`, `heldBlocks`, `undo/receipt.ts`, the
journal-row provenance) goes when the server's host moves; until then it is what production
runs. Probe: [loro-write](qa/loro-write.md).

## What an Undo reads

No Yjs item is followed to undo an edit. Each AI write records its `delta` (the blocks it changed,
before and after), and Undo, revert and the card's state read that against the text as it is now
([content-merge](content-merge.md#reading-an-ai-edit-against-a-text-stands)). The receipt's `effect` still names the
items a write inserted and deleted (`captureEditParts`, in `undo/receipt.ts`), which the model's
inverse reads; `heldDeletes` keeps a delete the room had already made out of it.

A block write keeps who wrote which characters only where text was inserted: `retainShared`
(`resolver/lower-block.ts`) keeps the old characters of a changed run and writes just the
insertions when the old run is a subsequence of the new one (`dog`→`dXoYg`, `cat`→`cats`).
Any other change, a deletion inside a word or a letter swap, writes the run whole, so a replaced
word never has letters of two authors. A writer's letter swap or deletion inside the AI's word
therefore lands as a replacement, and Undo leaves it alone.
