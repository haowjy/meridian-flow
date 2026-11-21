# agent-edit diff: block diff, correspondence and the Yjs block writer

`src/diff/` is the pure text model: which block of one version is which block of the other
(`correspond`), what changed between two block lists (`diffBlocks`), some of those changes applied
to the base (`composeHunks`), and the minimal Yjs writer (`writeBlocks`). It depends on ProseMirror
and Yjs only, so the browser and the server import the same functions. The three-way merge in
`src/content-merge/` ([page](content-merge.md)) builds on it.

Who uses it now:

- The Live turn inverse (`content-merge/stands.ts`, server `inverse-text.ts`): `editChanges` cuts an
  AI edit's recorded delta into changes with `changeGroups` and `composeHunks`.
- The server's document writes (`writeBlocks`, `readBlocks`): a Work-created document's first text,
  the turn inverse's writes.
- The browser: `countWords` (word count), `wordDiff`/`diffKeys` (a saved edit's diff in chat).

Review of a Work's changes reads suggestion marks (`packages/suggestions`), not this diff.

## Hunks and changes

`diffBlocks(base, draft)` returns both token sides, the cleaned hunks, the raw ones and the
alignment. `blocksEqual` counts whitespace and marks, so `captureDelta` records an edit that only
changed either.

`changeGroups` (`groups.ts`) joins hunks into one change when fewer than three unchanged words
separate them (a block start counts as one word), across paragraph breaks. A block the id pairing
found moved is a removal where it was and an addition where it is; both hunks join one group marked
`move`, so a change can never take half of a move. `editChanges` skips move groups.

`composeHunks(schema, diff, selected)` returns block-range patches, each covering the smallest block
range no hunk straddles, so two hunks in one paragraph compose jointly into one patch.
`applySpanPatches` puts them into the base's blocks.

Words are split by a regex of our own (`segmentText` in `tokens.ts`), never `Intl.Segmenter`, whose
word breaks follow the engine's ICU (Node keeps `a.b` one word and Chrome splits it). A token's key
must not depend on the order a schema lists a node's attrs (`stableJson`).

## Only diff the units whose nodes changed

`align` walks `correspond`'s pairs: each pair, with the pieces a split or a join left beside it, is
one **unit**, and an equal one-to-one unit has no hunks. Blocks between units are a removed run, an
added run, or one replacement marked `unpaired`. A weak trie keyed by the ordered retained base
nodes, a side boundary and the ordered retained draft nodes caches a unit's hunks and their
refinement, so a re-diff after a write touches only the unit whose nodes changed. Caches change
cost, never output.

Order matters within a unit:

1. Word and mark refinement runs before boundary separation, because retaining a leading block
   token can turn a complete replacement into a partial edge.
2. Separation splits partial edge blocks from complete consumed blocks, pairs complete replacement
   blocks in order, and detaches excess blocks (inside one unit only). Adjacent pure fragments from
   one separated replacement stay one edit. Intervals with no complete consumed block keep their
   split/join structure.
3. Canonicalization runs last against the final boundaries. It slides only pure insertions and
   deletions, never replacements.

Cached offsets are unit-local and publication copies them, so moving a paragraph or typing before
it cannot mutate another unit's coordinates. No schema-bound token or node is reused across schemas.

The size cap guards one oversized unit. A unit over budget skips word-level pairing: its token keys
are diffed by `boundedDiff` (Myers, exact up to 1,000 edit operations, about 500 replaced words;
cost bounded by that distance, not by size), so one typo in a 10,000-word paragraph is one small
hunk. Past 1,000 operations it is one replacement of what its ends do not share.

## The Yjs writer

`writeBlocks(fragment, schema, target)` writes target blocks as per-word edits, so every item the
target leaves alone keeps its identity and a peer's concurrent edit to it survives. A block paired
by id is edited in place through the model's lowering (`lowerBlock`, `applyOps`); a block that
moved, or whose id now names another type of element, is deleted where it was and inserted where it
is, with its one id. Before editing a gap the writer splits existing word boundaries in
client-clock order (`splitTextBoundaries`), which avoids repeated shifts of Yjs's struct arrays
during the backwards block write and allocates no clocks.

## Block correspondence: by id

Every block has a permanent `id` (`@meridian/prosemirror-schema` `block-id.ts`: set where the block
is made, kept through split, join, paste and undo), so the merge and the writer do not guess which
block is which: `correspond(old, next, { byId: true })`.

1. A block pairs with the block of the other side that has its id and a compatible kind (text
   blocks with text blocks, others by type). A repeated id pairs its first block only.
2. Of the pairs, the longest run in order stays; the rest are **moved** (`Correspondence.moved`).
   When two blocks swapped, the one the other side edited stays and the unchanged one moved, so
   its edit travels with it; a block the other side removed is the one that moved, so a move
   against a removal is a clash (`staysFor` in `content-merge/merge.ts`).
3. Blocks with no id pair among themselves by guess mode, in the gap between two staying pairs.
4. **Pieces**: an unpaired block directly beside a pair, with half its words in the pair's other
   side and the pair reading better with it, is a split's or a join's piece. An id pair is final:
   pieces extend a unit and never move the pair (`rootUnits` re-roots guess pairs only), and a
   block that has a pair of its own by id is nobody's piece.
5. Every other block is removed or added. There is no scoring of leftovers against each other.
6. Both sides made the same block at one place (equal but for ids: the same split, or the same
   paragraph typed twice): one block, with live's id (`unifyAdded`, the rule
   `same-block-added-twice`). Two similar but unequal paragraphs typed on both sides are two blocks.

**Guess mode** (`correspond(old, next)`) is what the model's write (its Markdown has no ids) and a
block with no id use; `diffBlocks` and the Yjs writer call the id mode and guess only for blocks
without an id. The ends and anchors pair first, then each gap by same content, then the share of
words in common; a gap too large to score is cut at its similar pairs.
