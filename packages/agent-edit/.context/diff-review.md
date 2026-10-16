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
short excerpt. The projection is pure and retains nothing, so a caller that
keeps PM nodes between edits pays only for the changed region.

## Attribution footprint and names

Classification has two phases over raw word/structural boundaries. The mandatory
footprint collects live item IDs, tombstones over the entire repeated-text slide
envelope, format items and changed attribute keys. Token-edge whitespace belongs
to the raw boundary; neighbouring unchanged words do not. Rebuilt blocks include
their recreated text. Membership and the Apply record are derived only here.

Optional character refinement can name fewer authors, but cannot mutate the
footprint. A diff budget, slide cap or alignment-work limit silences names, not
membership or Apply evidence. The room's Apply records establish accepted items
as base, and Undo-time restoration links resolve recreated IDs to their original
parts. Without an Apply record, surviving AI items inside a later raw-word change
remain conservatively pending even if the character edit touches only writer text.

## Apply and local Discard are the same operation on two sides

`composeGroups` selects hunks by group id and returns block-range patches, each
covering the smallest block range that no hunk straddles, so two hunks in one
paragraph compose jointly. `apply` yields the base with the selected hunks
applied (the server merges that patch into live and into `review_base`).
`discard` yields the draft with the selected hunks reverted; the editor writes it
into the room as the writer's own edit. Unknown ids are ignored.

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

## Late peers

A peer update authored before it received a rebase can type into, or delete
from, text the rebase already removed or re-created; Yjs would merge that into
dead state. `recoverLatePeerEdits` writes the surviving typing as its own
paragraph beside its last known neighbour and never replays the stale deletions
(a reconnect resends the whole delete set). `invisibleInsertions` reports words a
reply wrote into text the writer discarded; it never refuses them. Rationale and
rules: the [late-peer recovery decision][late-peer].

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
