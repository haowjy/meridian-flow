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
`undo/forward-inverse.ts`, `undo/restore-seam.ts` and `diff/`, which is why `yjs` is exactly pinned in
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

A replacement is a deleted run with the part's insertion beside it. The deleted run stays gone
only when the part's inserted side is no longer visible beside it *and* an item written after
the part (a clock at or past the part's `frontier`, read on the original of an Undo- or
Redo-restored copy) bounds the gap: the writer or a pull replaced the text, and restoring would
double it. A plain deletion of the insertion leaves nothing there, so the original comes back.
The gap's edge is read across the run's *seam* (`undo/restore-seam.ts`): its siblings the part
could not see as text (tombstones, marks, the part's own items and their copies, writing newer
than its frontier), up to the first text the inverse removes or the first visible text the part
saw. While that removed text still stands at the end of the seam, past the writer's typing, the
run is not stranded.

**Where a restored run goes.** Yjs restores a deleted item at its tombstone, and `Y.Text` puts
an insert after every tombstone at its position, so a writer's word typed before a replacement
lies between the old word's tombstone and the AI's insertion. The planner (`readSeams`) moves a
run, whole, to directly left of the text the inverse removes when all hold: that text ends the
run's seam on the right with visible writing between; no removed text ends it on the left; no
visible writing sits between the run's own pieces (writing inside a word stays inside it); the
run holds text, not only marks; the removed text was inserted at the run (its original's
`origin` chain, character by character, reaches the run through nothing but marks and the part's
own items: adjacency alone pairs a deletion with an unrelated insertion once the writer rewrites
what lay between); and the marks in force, leaving out the removed side's own, are the same at
each piece's tombstone and at the new place. Everything else stays at its tombstone. A run only
ever moves right, so Redo, whose returning text lies right of what it replaces, is unchanged. The
planner reads the host's document from `classify` and never writes: pieces are per character,
places are computed only for an inverse being executed (`InversePlan.place`), and the executor
(`restoreBefore` in `yjs-mutation.ts`, Yjs's `redoItem` with the neighbours given) splits items
and copies each run where it is told. The stranded condition deliberately does not ask for the
origin chain: keeping a run is never worse than Yjs's place, and the chain stops at a tombstone
older than the part (a typo backspaced at the end of the word), where asking would lose the word.
Yjs does not record when a deletion happened, so such a tombstone also keeps a run home.
A pull or Apply keeps who wrote which characters only where text was inserted: `retainShared`
(`resolver/lower-block.ts`) keeps the old characters of a changed run and writes just the
insertions when the old run is a subsequence of the new one (`dog`→`dXoYg`, `cat`→`cats`).
Any other change, a deletion inside a word or a letter swap, writes the run whole, so a replaced
word never has letters of two authors. A writer's letter swap or deletion inside the AI's word
therefore lands as a replacement, and Undo leaves it as the writer edited it (`changed`).
Review grouping and the model's text-derived status never use this rule.

**Word rule (Un-Apply only).** With `keepLaterWords: true`, `computePreparedInverse` compares the
text blocks a part's inverse touched, before and after, on the scratch copy. If a word (visible
characters with no whitespace, inside one text block; an inline atom or hard break ends it) that
holds a later character reads differently afterwards, the part is left standing as `changed`
(`changesLaterWord`) and the scratch is swapped back, so the next part is computed as if this one
was never tried. A later character is a visible one that is not the part's own, whose original
(`Lineage.root`, so restored text counts as its original) is at or past the part's `frontier`.
Marks are not characters. The chat card's Undo leaves it off (an owner question: the recorded rule
is that Undo never refuses over a writer's typing). Not covered: a later deletion that glues words
("One small" + restored "cat." gives "One smallcat"), because no later character is visible.
