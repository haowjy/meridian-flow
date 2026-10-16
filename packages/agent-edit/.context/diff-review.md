# agent-edit diff — the review model

`@meridian/agent-edit/diff` (`src/diff/`) is the pure text model behind draft
review, content Apply, local Discard and the live rebase. It depends on
ProseMirror nodes and Yjs only, never on server code, and every Meridian layer
(browser, server, migration) imports the same functions so they agree on what a
draft "has changed".

## The model

A text branch's Y.Doc holds two top-level fragments: `prosemirror` (what the
writer and the AI edit) and the server-owned `review_base`
(`REVIEW_BASE_FRAGMENT`): live's text as of the branch's `base_revision`. Every
view of the review is a function of those two block lists.

| Question | Function |
|---|---|
| Does the draft differ from its base (`has_effect`, `hasChanges`)? | `!blocksEqual(base, draft)` (`equal.ts`): whitespace and marks included |
| What are the changes? | `diffBlocks` then `projectReview(diff)` (`hunks.ts`, `review.ts`): a `ReviewProjection` of `ReviewGroup`s |
| What does Apply or local Discard write? | `composeGroups(schema, projection, ids, "apply" \| "discard")` giving `SpanPatch[]`, then `applySpanPatches` (`compose.ts`) |
| How does live's newer text reach a draft? | `rebase(schema, base, live, draft)` (`merge.ts`) |
| How do the fragments get written? | `writeBlocks` (`writer.ts`): per-word Yjs edits so untouched items keep their identity |
| Who wrote this change, and which AI writes are in it? | `classifyChanges` (`attribution.ts`): byline and members per change; the restoration links Undo records (`restorations.ts`), the Apply record (`apply-record.ts`) |

A **change** is one `ReviewGroup` (type name; `changeId` on the wire is its
content-derived `id`): hunks join when fewer than `CHANGE_MARGIN` (3) unchanged
words separate them, across paragraph breaks, and a block removed in one place
and added in another joins both places as a `move` group so Apply and Discard
can never take half of one. A group carries the draft positions the editor
decorates (`inserted`, `anchor`), the base content drawn red (`removed`) and a
short excerpt. A hunk containing changed block attributes carries expanded `formatContext` paint:
its own replacement plus aligned unchanged text from the affected block, split
around every other hunk. This also covers a combined heading and leading inline
edit. Its row includes its own replacement and context in document order, never
another hunk's replacement. The painter uses disjoint ranges, with a whole-block
mark only for a standalone attribute change with no other edit in the block;
raw token ranges, identity and composition never expand. Formatting
has red before-text and green after-text just like prose replacements. The projection is pure and retains nothing, so a caller that
keeps PM nodes between edits pays only for the changed region.

## Only diff the units whose nodes changed

Equal paragraphs anchor the diff and need no token search. Each changed
paragraph, or small run of adjacent changed paragraphs needed to read a split or
join together, is one **unit**. A weak trie keyed by the ordered retained base
nodes, a side boundary, and the ordered retained draft nodes caches that unit's
token hunks and their word/mark refinement. Canonicalization still runs against
the raw neighbouring boundaries: it moves only pure insertions/deletions, whereas
refinement only splits replacements. Like ProseMirror's view, it follows immutable node identity: a
keystroke or AI write re-diffs only the unit whose nodes changed. Other units
reuse their hunks; the paragraph-level pass supplies their new positions.
Cached offsets are unit-local and publication copies them, so moving a paragraph
or typing before it cannot mutate another unit's coordinates.

The size cap is a guard for one oversized unit, not the primary performance
mechanism. Alignment never uses a wall-clock deadline: every diff-match-patch call goes through `textDiff` in `tokens.ts`, which passes `timeout: -1` (the library reads `timeout || 1`, so 0 would mean one second).
Gaps of at most 1,000 tokens per side stay whole, preserving small splits and
joins. Larger gaps use ordered 80%-similar paragraph anchors; unequal residual
runs try 40% anchors. Remaining paragraphs pair in order, with excess paragraphs
inserted or deleted. Position bounds work, not whether text is equal. A unit
still over budget is one whole replacement, without later word-level refinement.

Disjoint paragraph probes took 18–29 ms around 1,000 words, versus up to 128 ms
around 1,500, motivating the guard. Strong diagonal matches avoid the paragraph
matching table for dense in-place edits. Caches change cost, never output. The paragraph anchor search also retains each node pair's
word-set overlap; a warm key must not repeat the same intersections for every candidate.

Projection caches position-independent hunk content by retained node ranges, then caches
an unchanged group's hash and excerpt by those content identities. Cached hunk content
includes removed JSON and kind; token-to-character offsets are per retained draft node.
Grouping, move pairing, occurrence ranks and global hunk coordinates still recompute. A
changed group still hashes its whole content (the existing hash/wire contract is unchanged).
No schema-bound token or node is reused by text across schemas.

Pure character-refinement scripts also reuse retained draft nodes and the base
array, keyed by their exact input strings. Their cache is bounded to the 64k
character budget per node, and hits consume the same naming budget as misses.
No Yjs evidence, membership or author result is cached: those still read the
current room on every classification. Incremental attribution and publication
remain separate work (#900).

## Attribution footprint and names

Classification has two phases over raw word/structural boundaries. The mandatory
footprint collects live item IDs, tombstones over the entire repeated-text slide
envelope, format items and changed attribute keys. Token-edge whitespace belongs
to the raw boundary; neighbouring unchanged words do not. Rebuilt blocks include
their recreated text. Membership and the Apply record are derived only here.

Optional character refinement can name fewer authors, but cannot mutate the
footprint. Only a character edit containing a deletion can also check a wholly
recreated replacement's raw word for exact base tombstones: equal letters in new
items are not retained base anchors. Thus
`sword → blade → sabre` names both the remover of `sword` and the writer of `sabre`,
without turning conservative membership into a byline. An insertion-only result
such as `sword → swords → swordfish` names only the writer of `fish`, not the
historical remover of the recreated `sword`. Whole-word evidence names a remover
only when their character count exceeds the characters outside a visible deletion;
equal letters may account for the other removers entirely. Surviving base characters
or unresolved inserted identities exclude this whole-replacement naming check. A diff budget, slide cap or alignment-work limit silences names, not
membership or Apply evidence. The room's Apply records establish accepted items
as base. Discard's `writeDiscardBlocks` preserves text-run identities even with
inline atoms or low similarity. Structural rebuilds record copied equal spans as
source links; only the other inserted IDs become base write-backs. AI/rebase
`writeBlocks` keeps its allocation policy. Both record kinds share the writer-writable
restoration root. `recordRestorations` wraps each history's Undo/Redo in a transaction
with the manager's origin, so prose and links travel in one update. The same record includes Undo's deletions: removing a Discard base
copy must not count as a second deletion of the review base. Its origin remains
base for Redo, and later ordinary deletions still name the writer. The root lies
outside its fragment scope. Links resolve through chains and validate known ID
ranges, not tombstone content: originals and intermediate copies can be GC structs. Without an Apply record, surviving AI items inside a later raw-word change
remain conservatively pending even if the character edit touches only writer text.

Provenance includes the snapshot its parts cover. An unlisted ID is the writer only within that state
vector or from the caller's explicitly identified local browser client; an unlisted deletion requires
coverage in the snapshot's delete set or an explicitly supplied locally witnessed delete set.
Deletion evidence addresses the actual item ID, never an ancestor reached by a restoration link;
restoration chains recover insertion origin only. Without deletion evidence, the item is unresolved:
its footprint keeps all candidate parts, and uncertain naming contributes no author. A state vector alone cannot fence deletion-only writes. The classifier also returns the unresolved item
ranges so the browser requests evidence revisions rather than every text snapshot.

## Apply and local Discard are the same operation on two sides

`composeGroups` selects hunks by group id and returns block-range patches, each
covering the smallest block range that no hunk straddles, so two hunks in one
paragraph compose jointly. `apply` yields the base with the selected hunks
applied (the server merges that patch into live and into `review_base`).
`discard` yields the draft with the selected hunks reverted; the editor writes it
into the room as the writer's own edit. Unknown ids are ignored.

The writer skips sequence matching when two blocks share no words: the exact
similarity is zero. Before editing a gap, it splits existing word boundaries in
client-clock order, avoiding repeated shifts of Yjs's struct arrays during the
backwards block write. Splitting allocates no clocks; the edits, identities and
restoration records remain unchanged.

## The rebase

`rebase` is a three-way merge of top-level blocks (base, live, draft) and never
a Yjs pull, because nothing relates live's items to the draft's. Tokens of each
side align to base (`align.ts`, `tokens.ts`), moved paragraphs take the other
side's edits with them (`merge-order.ts`), and hunk lists merge by rule
(`merge-hunks.ts`, `merge-settle.ts`): one side's hunk applies, equal results
apply once, insertions at one point keep both (live first). Anything else is a
`Conflict` and the draft's version stays, so the conflict shows in review as a
diff of the new base (live) against the draft. The server writes the result into
both fragments as `DRAFT_SERVER_CLIENT_ID` (1) in one transaction. The same
function plans a content Apply's live update, with the patch as the draft side.

Move-text matching indexes the complete deleted-content stream by token key,
extends only matching seeds at the start of a diagonal run, and keeps the
first-inserted then first-deleted tie rule. Only after selecting the globally
longest run does it check whether the other side touched that source or pasted
the same text. Filtering sources first would change the winner and can silently
lose moved words. Both the modifying and report-only passes use this ordering.
Work depends on token counts and matching seeds, never elapsed time; repeated
suffixes are not extended again.

## Late peers

A peer update authored before it received a rebase can type into, or delete
from, text the rebase already removed or re-created; Yjs would merge that into
dead state. `recoverLatePeerEdits` writes the surviving typing as its own
paragraph beside its last known neighbour and never replays the stale deletions
(a reconnect resends the whole delete set). `invisibleInsertions` reports words a
reply wrote into text the writer discarded; it never refuses them. Rationale and
rules: the [late-peer recovery decision][late-peer].

Late-peer detection indexes the incoming structs once by client and clock. Parent/origin
lookups must not scan the complete update for each incoming item: a whole-draft
Discard or Undo can carry tens of thousands of structs. The existing ancestry
depth bound and the ordered lost-edit output are unchanged. The shared pinned
Yjs adapter owns that index: noncanonical updates with repeated, out-of-order
client blocks retain first-match lookup rather than changing admission.

The caller's contract: `LateTyping` is opaque in-process memory the host keeps
per draft, so a reconnect that sends one keystroke per frame extends one
paragraph. A later *stale* frame never deletes recovered typing. Ownership ends
when the draft no longer shows the paragraph exactly as written, after which it
is never touched.

## Migration seam

`convertLegacyDraft` (`draft-base.ts`) is the pure conversion a data step uses to
give a pre-`review_base` branch its base from its `live_cut` text and an
`UNKNOWN_BASE_REVISION`, so the first rebase merges live's edits since. The
migration owns the CAS (`packages/database/src/migration-steps/`).

[late-peer]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/late-peer-recovery.md
