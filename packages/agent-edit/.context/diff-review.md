# agent-edit diff — the review model

`src/diff/` is the pure text model behind draft review, content Apply, local Discard
and the live rebase. It depends on ProseMirror and Yjs only, so the browser, server
import the same functions and agree on what a draft has changed. The
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
other inserted IDs become base write-backs. AI and rebase `writeBlocks` retains a
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
applied). `applyBase(schema, committed, O, P)` returns P when O equals the committed base,
otherwise the blocks of `rebase(schema, O, committed, P)`. Browser queue folds and server
base writes use this same function.

`baseViewDelta` builds one set of disjoint whole-block patches, never a chain of queued
clicks. `validateSpanPatches` checks the resulting blocks against the schema before
composition is trusted. Unused side coordinates convey projection positions, not write
authority.

## The rebase

`rebase` is a three-way merge of top-level blocks. Moved paragraphs take the other side's
edits with them, and hunk lists merge by rule: one side's hunk applies, equal results apply
once, insertions at one point keep both (live first). Anything else is a `Conflict` and the
draft's version stays, so it shows in review as a diff of the new base against the draft. The
same function plans a content Apply's live update, with the patch as the draft side. Shared
insertions at either edge of an adjacent replacement peel off before clustering, so
`The → A big black` and `+big black` keep one copy.

A table is one token to `align` (review paints its cells apart: `ReviewHunk.inner`), so a cluster in which both sides changed containers is
merged over their children (`mergeContainers`), pairwise when each side replaced a run of the same
containers, and at every depth. It falls back to a clash of the whole block (`whole-block-unit`)
when the types or counts differ, when the merged node fails `check()`, or when a merged table's
cells, with their `colspan` and `rowspan`, do not fill a rectangle. (Flat PR 3 turns quotes into
block attributes and ends the quote half of this.)

### Block correspondence: by id

Every block has a permanent `id` (`@meridian/prosemirror-schema` `block-id.ts`: set where the block
is made, kept through split, join, paste and undo), so the merge does not guess which block is
which: `correspond(old, next, { byId: true })`.

1. A block pairs with the block of the other side that has its id and a compatible kind (text
   blocks with text blocks, others by type). A repeated id pairs its first block only.
2. Of the pairs, the longest run in order stays; the rest are **moved** (`Correspondence.moved`).
   When two blocks swapped, the one the other side edited stays and the unchanged one moved, so
   its edit travels with it; a block the other side removed is the one that moved, so a move
   against a removal is a clash (`staysFor` in `merge.ts`).
3. Blocks with no id pair among themselves by guess mode, in the gap between two staying pairs.
4. **Pieces**: an unpaired block directly beside a pair, with half its words in the pair's other
   side and the pair reading better with it, is a split's or a join's piece. An id pair is final:
   pieces extend a unit and never move the pair (`rootUnits` re-roots guess pairs only), and a
   block that has a pair of its own by id is nobody's piece.
5. Every other block is removed or added. There is no scoring of leftovers against each other.
6. Both sides made the same block at one place (equal but for ids: the same split, or the same
   paragraph typed twice): one block, with live's id, because live is the next review base
   (`unifyAdded`). Two similar but unequal paragraphs typed on both sides are two blocks.

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

### Block attributes: `block-attributes-merged`

Before the token merge (`mergeAttributes` in `merge.ts`), a block both sides kept (paired by id,
one type on all three) takes each attribute from the side that changed it, and the draft's where both
changed it to different values (one `attributes` conflict for the block). The three versions then
carry the same attributes, so the token merge sees none changed and a text edit or an inserted block
beside it merges as if no attribute had changed: live indents an item and the draft checks it, and
both land. A block one side removed is left to the token merge. A table's rows and cells are not
reached (`mergeContainers` has its own attribute rule).

A removal of several blocks is one removal per block in the merge, so one side's removal of a
run meets the other side's edit or removal of each block separately. A run of removed blocks and
a run of added blocks between two units are a removal and an addition after it, so a side that
removed what the other also removed and added something else keeps what it added. A shared edge
of two replacements is kept once only inside one block (`shared-edge-kept-once`): two paragraphs
that end in the same word do not share it. A hunk keeps the side range it came from
(`sfrom`..`sto`); a filter such as moved-text dropping changes its payload and `sidx`, never its
range.

What stays doubled: text one side carried out of a block into another place (a cut and paste, a
split then a join) while the other side changed the block it came from. Characters have no id across
a draft and live, so the draft's paragraph stands and the carried text is in the result twice; review
shows the draft's paragraph as an addition the writer can refuse. `moved-text-dropped` is as it was
(three words, where live's pasted text meets a source the draft changed).

### Stretches: `draft-wins-stretch`

Where one side removed a block the other changed, or both changed which blocks there are at one
place, the draft's version of that stretch stands as one counted clash, and the merge never combines,
doubles or silently drops words. `settleStretches` (`src/diff/stretch.ts`) runs before any token
merges. It lays each side's correspondence over the base: every block of a side sits in a base
block's place or in a gap, and the places it changed are text (paired in place, differs), removed, or
restructured (split, joined, moved, or added in a gap). Two sides' changes clash where they meet
and the token merge cannot be trusted with them:

- at a base block: one side removed the block and the other changed it in any way, or both
  restructured it, or one side split or joined a container (a table row) that the other
  changed: a container is one token to the token merge, so an edit cannot travel into its pieces
  as it does into a paragraph's;
- at a gap inside a join: the other side has anything there.

Text against text, text against a split, a join or a move of that block (the edit travels with
the block), additions by both sides at one gap, and removals of different blocks are left to the
token merge. A paragraph the draft moved and live deleted stays where the draft put it, with a clash;
live moved and the draft deleted stays removed. A stretch is the changes joined by clashes; where
both sides hold the same blocks in it in the same places (a moved base block's place is the order
merge's), it is no clash. Otherwise the draft's blocks stand, live is handed on with its changes to
the stretch undone (the base's blocks in place), one conflict is recorded with the base blocks it
covers, and live's words the draft lacks count under `overrode`. Live is set back to the base
rather than to the draft's blocks: copying the draft's blocks in doubled them when the sides
also disagreed about order.

A block rewritten in place keeps its id, so both sides' edits to it go to the token merge (live's
new sentence with the draft's appended word, no clash); a block deleted and another typed in its
place is two blocks, and the draft's edit of the deleted one brings it back beside the new one with
one clash.

Move-text matching checks whether the other side touched a source or pasted the same text
only after selecting the globally longest run. Filtering sources first would change the
winner and can silently lose moved words. Both the modifying and report-only passes use this
ordering.

## Late peers

The rules are in the [late-peer recovery rule][late-peer]. Detection indexes the incoming
structs once by client and clock in the shared pinned Yjs adapter; parent and origin lookups
must not scan the whole update per item, because a whole-draft Discard or Undo can carry tens
of thousands of structs. Noncanonical updates with repeated, out-of-order client blocks keep
first-match lookup rather than changing admission.

`retainLateTypingDeletions` preserves separator-deletion observations when a host's append
awaited receipt I/O: it keeps the append's new spans and drops stale backspaces against
remembered typing.

## What the merge returns

`rebase` returns the merged `blocks`, the `conflicts` (where both sides changed the same text or
blocks; the draft's version is in `blocks`), `overrode` (the live words the draft actually
replaced in contested text) and `orderConflict`. Every block it returns has an id (a paragraph it
makes from nothing gets a fresh one, so `writeBlocks` never throws on its output).

[review]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#what-review-shows
[authors]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#who-wrote-a-change
[cost]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#what-review-shows
[late-peer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-store-concurrency.md#a-late-peer-keeps-only-its-surviving-typing
