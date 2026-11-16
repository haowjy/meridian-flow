# agent-edit — contracts and architecture

Read the page that owns the seam you are changing:

- [Port contracts](port-contracts.md): what a host must do that the port types can't say.
- [Write architecture](write-architecture.md): planning, capture, targeting and results.
- [Link identity](link-correspondence.md): ref assignment at every write door.
- [Diff review](diff-review.md): pure text review, composition and local Discard.
- [Content merge](content-merge.md): the three-way merge of a draft with live: its rules, repairs, rescues and known losses.

Deferred work is in [TODO.md](TODO.md) and [FUTURE.md](FUTURE.md); rejected
directions are in [ALTERNATIVES.md](ALTERNATIVES.md).

## Pinned reconstruction adapter

Several files read Yjs struct internals, among them `frontier.ts`, `model/block-hash.ts`,
`undo/forward-inverse.ts` and `diff/`, which is why `yjs` is exactly pinned in
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
id (`byId`: [diff-review](diff-review.md#block-correspondence-by-id)). Everyone else asks in guess
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
content only; the Yjs writer and review pair by id.

What this keeps is the element, not every character's author: an image or break inserted
inside a text run copies the text after it into a new run, so those characters change
author and a peer's edit aimed at them can be lost. `main` rebuilt the whole paragraph
there; this is a rare case left as it is.

## Forward-inverse per-peer rule

An inverse acts per item of the receipt, never on a dependency closure: each inserted item is
deleted if still visible, each deleted item is restored if its parent is live (or is restored
with it) and, for a map entry, nothing newer has replaced it. Anything else is skipped as
already gone, so another peer's typing never refuses it and is never removed. An AI element
holding a live descendant outside the receipt stays (`delete-filter.ts`) with all its attributes
(`id` first: an element without one is not a block); only the AI's own text inside it goes. `executeUndo` runs with `ignoreRemoteMapChanges: false` so Yjs itself
leaves a writer's later attribute value.

A replacement is judged per change, not per part: one `replace` that touches two places in a
paragraph is one part with several changes. `pairEdit` pairs each deleted run with the
inserted text that took its place (`pairChanges`, from the immutable items: the inserted run's
`origin` or `rightOrigin` sits on the deleted run, consecutive deleted siblings are one run, and
text deleted before the write is stepped over, since every backspace leaves some) and stores the
pairs in `effect.replaced`. Each write is paired right after it applied, before the next write in
the same call or batch changes the document, so a later write's deletions never count as earlier
ones; `captureEditParts` only drops cross-part transients from the pairs. Only a receipt that can
be undone is paired (an agent write, a Revert, an Undo), never a writer's frame. The walk itself
can still pair wrongly at the write (a restore receipt whose neighbours the writer deleted).
`replacedGone` pairs a receipt written before this from the document as it stands, up to
restoration lineage, the one place a later deletion can still change the answer. A deleted run comes back while any visible text of its replacement still
stands: beside whatever the writer put there, so a writer who typed before the word gets "One
smallvery  cat.", and a partly overtyped word joins ("kneltkn"). Once none of the replacement's text
is visible (a Discard took it out, or the writer typed over every letter), that run stays deleted
and the old word returns only with the writer's own text, never as a second copy beside it. A
deleted run with no replacement always restores, and a part with nothing left to remove or restore
reads `changed`. Only text counts as a replacement standing: attributes, containers and formats
(a heading level, a list marker) are reversed by their own item, and never authorize bringing text
back. Apart from this and the descendant protection above (Flow keeps the writer's text inside a
block the AI created, where plain Yjs deletes it), an inverse equals a plain `Y.UndoManager`'s.
A pull or Apply keeps who wrote which characters only where text was inserted: `retainShared`
(`resolver/lower-block.ts`) keeps the old characters of a changed run and writes just the
insertions when the old run is a subsequence of the new one (`dog`→`dXoYg`, `cat`→`cats`).
Any other change, a deletion inside a word or a letter swap, writes the run whole, so a replaced
word never has letters of two authors. A writer's letter swap or deletion inside the AI's word
therefore lands as a replacement, and Undo leaves it alone.
