# agent-edit — contracts and architecture

Read the page that owns the seam you are changing:

- [Port contracts](port-contracts.md): what a host must do that the port types can't say.
- [Write architecture](write-architecture.md): planning, capture, targeting and results.
- [Link identity](link-correspondence.md): ref assignment at every write door.
- [Diff review](diff-review.md): pure text review, composition, rebase and local Discard.

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
`.context/CONTEXT.md`). `src/yjs-text-runs.ts` routes an edit to the text that owns its
offset. Every walker of a block's children follows it: the writer pairs a run, never a
text, with a target run, and the model's unit addressing skips empty texts, which are
zero units wide and share a unit with the atom after them. A read never writes to the
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
rebuilds an element. Inside a block the writer pairs atoms the
same way, then reconciles the one text run in each gap between paired atoms with the run
rule above. The write path has no ids for the blocks it writes (the model writes text), so
pairing is by content only.

What this keeps is the element, not every character's author: an image or break inserted
inside a text run copies the text after it into a new run, so those characters change
author and a peer's edit aimed at them can be lost. `main` rebuilt the whole paragraph
there; this is a rare case left as it is.

## Forward-inverse dependency closure

A forward inverse closes over one Yjs dependency predicate: the selected edit's
retained structures and everything that depends on them. Review grouping and the
model's text-derived status never use this predicate.
