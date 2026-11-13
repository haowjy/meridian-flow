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

## Only diff the units whose nodes changed

Equal paragraphs anchor the diff. Each changed paragraph, or small run of adjacent
changed paragraphs needed to read a split or join, is one **unit**. A weak trie keyed by
the ordered retained base nodes, a side boundary and the ordered retained draft nodes
caches a unit's hunks and their refinement, so a keystroke or AI write re-diffs only the
unit whose nodes changed. Caches change cost, never output.

Order matters within a unit:

1. Word and mark refinement runs before boundary separation, because retaining a
   leading block token can turn a complete replacement into a partial edge.
2. Separation splits partial edge blocks from complete consumed blocks, pairs complete
   replacement blocks in order, and detaches excess blocks. Adjacent pure fragments from
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

## Merge correspondence

`rebase` returns `correspondence`, naming each output block's original base, live and draft
block indices (`output: null` records removed inputs), and `overrode`, the live words actually
replaced in contested text. No caller should rediff the result to recover the merge's pairing.

`composeHunks` optionally reports each selected hunk's block support in the final composed
side, for joining host ownership. A whole-block deletion has empty output support, so callers
keep its removed base support separately.

[review]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#what-review-shows
[authors]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#who-wrote-a-change
[cost]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-review.md#what-review-shows
[late-peer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/wiki/collaboration/draft-store-concurrency.md#a-late-peer-keeps-only-its-surviving-typing
