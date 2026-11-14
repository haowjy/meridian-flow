# agent-edit diff — the review model

`src/diff/` is the pure text model behind draft review, content Apply and local Discard.
It depends on ProseMirror and Yjs only, so the browser and the server import the same
functions and agree on what a draft has changed. The three-way merge of a draft with live is
in `src/content-merge/` ([page](content-merge.md)), which builds on this model. The
product rules are in [diff-based review][review], [change authors][authors] and
[review cost][cost]; this page holds the mechanics they don't state.

## The model

A text draft's Y.Doc holds `prosemirror` (what the writer and the AI edit) and the
server-owned `review_base`, the committed live text folded into this draft. Every view
of the review is a function of those two block lists. `has_effect` and `hasChanges` are
`!blocksEqual(base, draft)`, whitespace and marks included. Projection retains no
mutable review state.

Grouping joins review actions, not paint. The final refined alignment separates
complete removed or added blocks from adjacent inline replacements, including full
block renames with no retained word and simultaneous block-attribute changes, and
semantic cleanup preserves that on both token sides, so a whole-block move removal
anchors between paragraphs.

A hunk containing changed block attributes carries expanded `formatContext` paint: its
own replacement plus aligned unchanged text from the affected block, split around every
other hunk. Its row never includes another hunk's replacement. The painter uses disjoint
ranges, with a whole-block mark only for a standalone attribute change. Raw token
ranges, identity and composition never expand.

`ReviewHunk.attributes` says what the painter needs from a block's attribute change:
`only` (no text or mark changed, so the painter draws no struck copy) and `nested` (draft
positions of blocks whose `path`, `kind`, `marker`, `start` or `loose` changed; the painter
tints that block's marker, indent and bar and puts no mark over its text). A change with no
marker to paint (a heading level, alignment, a rule, figure or table) keeps the whole-block
mark. `hunkKind` calls a one-for-one replacement of a rule, figure or table by one of the
same type and content a "format" hunk. The hunk is the same hunk to Apply, Discard and the
count.

`ReviewHunk.inner` is set when a hunk replaced a table by its own edited copy whose rows and
cells pair by id one for one with the same attributes: the changes inside each cell, diffed as
a document of its own and placed in the draft. The painter paints those instead of the whole
table; the hunk is still the whole table to Apply and Discard. A table whose rows or cells
were added, removed or reordered, or whose cell attributes changed, paints whole.

## Only diff the units whose nodes changed

`correspond` (`src/diff/correspond.ts`) decides which block of one version is which block of the
other. `align` walks its pairs: each pair, with the pieces a split or a join left beside it, is
one **unit**, and an equal one-to-one unit has no hunks. Blocks between units are a removed run,
an added run, or one replacement marked `unpaired`. A weak trie keyed by the ordered retained
base nodes, a side boundary and the ordered retained draft nodes caches a unit's hunks and
their refinement, so a keystroke or AI write re-diffs only the unit whose nodes changed. Caches
change cost, never output.

Order matters within a unit:

1. Word and mark refinement runs before boundary separation, because retaining a
   leading block token can turn a complete replacement into a partial edge.
2. Separation splits partial edge blocks from complete consumed blocks, pairs complete
   replacement blocks in order, and detaches excess blocks (inside one unit only). Adjacent pure fragments from
   one separated replacement stay one edit, preserving split/join composition and
   identical concurrent-change collapse. Intervals with no complete consumed block keep
   their split/join structure.
3. Canonicalization runs last against the final boundaries. It slides only pure
   insertions and deletions, never replacements, so it cannot rejoin the separated paint.

Cached offsets are unit-local and publication copies them, so moving a paragraph or
typing before it cannot mutate another unit's coordinates. No schema-bound token or node
is reused by text across schemas.

The size cap guards one oversized unit; it is not the main performance mechanism.
Disjoint paragraph probes took 18–29 ms around 1,000 words, versus up to 128 ms around
1,500, which motivated it. A unit still over budget is one whole replacement, without
later word-level refinement.

Evidence indexes live apart from classification. Only root writes invalidate the room
indexes, before projection observers run; reads inside an open root transaction rebuild
against its current contents. Restoration validation tracks missing clocks for future
references, so their arrival can make a previously invalid record valid without changing
the root. Cached evidence must not become a cached final classification across edits.

## Attribution footprint and names

Classification has two phases over raw word and structural boundaries. The mandatory
footprint collects live item IDs, tombstones over the entire repeated-text slide
envelope, format items and changed attribute keys. Membership and the Apply record are
derived only here. Token-edge whitespace belongs to the raw boundary; neighbouring
unchanged words do not.

Optional character refinement can name fewer authors but cannot mutate the footprint. A
diff budget, slide cap or alignment-work limit silences names, not membership or Apply
evidence.

- Only a character edit containing a deletion can also check a wholly recreated
  replacement's raw word for exact base tombstones, because equal letters in new items are
  not retained base anchors. So `sword → blade → sabre` names both the remover of `sword`
  and the writer of `sabre`, while `sword → swords → swordfish` names only the writer of
  `fish`.
- Whole-word evidence names a remover only when their character count exceeds the
  characters outside a visible deletion. Surviving base characters or unresolved inserted
  identities exclude this check.
- Without an Apply record, surviving AI items inside a later raw-word change stay
  conservatively pending even if the character edit touches only writer text.

Discard's `writeDiscardBlocks` preserves text-run identities even with inline atoms or
low similarity. Structural rebuilds record copied equal spans as source links; only the
other inserted IDs become base write-backs. AI and pull `writeBlocks` retains a
one-to-one same-type flat paragraph even with no shared words.

`recordRestorations` wraps each history's Undo and Redo in a transaction with the
manager's origin, so prose and links travel in one update. The same record includes
Undo's deletions: removing a Discard base copy must not count as a second deletion of the
review base. Its origin stays base for Redo, and later ordinary deletions still name the
writer. Links resolve through chains and validate known ID ranges, not tombstone content,
because originals and intermediate copies can be GC structs.

Provenance includes the snapshot its parts cover. An unlisted ID is the writer only within
that state vector or from the caller's identified local browser client; an unlisted
deletion requires coverage in the snapshot's delete set or a supplied locally witnessed
delete set. A state vector alone cannot fence deletion-only writes. The classifier returns
unresolved item ranges so the browser requests evidence revisions rather than every
snapshot. Deletion evidence addresses the actual item ID, never an ancestor reached by a
restoration link; chains recover insertion origin only.

A wholly removed paragraph can text-align with a fresh empty replacement. When that
replacement has no character tombstones, its block deletion witness supplies the deleter
even for rebased base text that never existed in the draft. Recreated blocks do not bound
that witness: the candidate region extends to retained base containers, and competing or
uncovered tombstones leave the byline empty. A surviving container, or one with ordinary
character tombstones, cannot borrow another block's author. Only proven Undo deletions of
Discard base copies are excluded from that guard, so undoing Discard keeps the original
byline.

`originOf` and `deleterOf` are current-ID readers, not review-role readers: they never
follow restoration links or consult Apply or Discard records. A receipt whose thread or
turn was deleted answers unknown rather than inventing an author. Call them against the
captured cut, since absence outside it is not proof of writer activity, and treat
provenance and its range arrays as immutable: the readers share interval indexes by
provenance object.

`appliedParts` associates positive Apply evidence with immutable receipt ranges. Any
overlap is evidence, not full receipt coverage, and absence of a change alone never proves
Apply: the host combines this with lifecycle and membership to tell pending from discarded.

## Apply and local Discard are the same operation on two sides

`composeGroups` returns block-range patches, each covering the smallest block range no hunk
straddles, so two hunks in one paragraph compose jointly. `apply` yields the base with the
selected hunks applied; `discard` yields the draft with them reverted, and the editor writes
it into the room as the writer's own edit.

Before editing a gap, the writer splits existing word boundaries in client-clock order,
avoiding repeated shifts of Yjs's struct arrays during the backwards block write. Splitting
allocates no clocks.

A group's id is a hash of its tokens' keys, and the browser (the editor's schema) and the server
(`buildDocumentSchema`) both compute it, so a key must not depend on the order a schema lists a node's
attrs (`stableJson` in `tokens.ts`). When they differed the server refused the click as `malformed`.

A frozen Apply click holds O (the optimistic base seen) and P (O with its selected groups
applied). `applyBase(schema, committed, O, P)` (`@meridian/agent-edit/content-merge`) returns P when O
equals the committed base, otherwise the blocks of `contentMerge(schema, O, committed, P)`. Browser queue folds and server
base writes use this same function.

`baseViewDelta` builds one set of disjoint whole-block patches, never a chain of queued
clicks. `validateSpanPatches` checks the resulting blocks against the schema before
composition is trusted. Unused side coordinates convey projection positions, not write
authority.

## The content merge

The merge, its rules and what it does when it cannot tell are on the [content merge page](content-merge.md).
It pairs blocks by the correspondence below.

### Block correspondence: by id

Every block has a permanent `id` (`@meridian/prosemirror-schema` `block-id.ts`: set where the block
is made, kept through split, join, paste and undo), so the merge does not guess which block is
which: `correspond(old, next, { byId: true })`.

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
   paragraph typed twice): one block, with live's id, because live is the next review base
   (`unifyAdded`, the rule `same-block-added-twice`). Two similar but unequal paragraphs typed on both sides are two blocks.

**Guess mode** (`correspond(old, next)`) is what the model's write (its Markdown has no ids) and a
block with no id use; review (`diffBlocks`) and the Yjs writer (`writeChildren`) call the id mode and
guess only for blocks without an id. The ends and anchors pair first, then each gap by same content, then the
share of words in common; a gap too large to score is cut at its similar pairs. 

Review and the Yjs writer use the same pairing. A block the id pairing found moved is, to `align`, a
removal where it was and an addition where it is; `Alignment.moves` names the pair and
`projectReview` joins both hunks into one `move` group, so Apply and Discard cannot take half of a
move (the earlier text-similarity scoring of removals against additions is gone). Of two swapped
blocks review keeps the first found in place; the merge's `stays` rule is not used. `writeChildren`
keeps the Yjs element whose block has the same id and edits it in place; a block that moved, or whose
id now names another type of element, is deleted where it was and inserted where it is, still with
its one id.

## Late peers

Detection finds typing under a deleted item and typing a delete removes without listing it; whose text it is comes from the journal (collab `writerText`), not from the memory.

The rules are in the [late-peer recovery rule][late-peer]. Detection indexes the incoming
structs once by client and clock in the shared pinned Yjs adapter; parent and origin lookups
must not scan the whole update per item, because a whole-draft Discard or Undo can carry tens
of thousands of structs. Noncanonical updates with repeated, out-of-order client blocks keep
first-match lookup rather than changing admission.

`retainLateTypingDeletions` preserves separator-deletion observations when a deferred observer
runs after another append: it keeps the append's new spans and drops stale backspaces against
remembered typing.

[review]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#what-review-shows
[authors]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#who-wrote-a-change
[cost]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#what-review-shows
[late-peer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-store-concurrency.md#a-late-peer-keeps-only-its-surviving-typing
