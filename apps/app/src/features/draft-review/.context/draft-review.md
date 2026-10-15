# Draft review reference

This reference covers the review model, Discard, Apply, and draft-only
settlement. Paths are relative to `apps/app/src`. Commands, rooms, paint, and
delivery are separate owners.

## The model

An item's text branch room holds two fragments: `review_base` (the live text as
of the branch's last rebase; the server advances it) and `prosemirror` (the
item's text). The review is `projectReview(diffBlocks(base, draft))` from
`@meridian/agent-edit/diff`, recomputed in the browser whenever either fragment
changes. Group ids are content hashes. An empty `review_base` is a real base
once the room has synced.

One runtime per draft room (`review-runtime.ts`) publishes an immutable frame
(`review-frame.ts`: diff and groups, `Y.Snapshot`, each change's pin) in a
`ReviewState`, joined with the chat-attribution hint and the draft's command
records. Mounted editors attach and paint it (`useInlineReviewSync`); with no
editor `useRoomReview` retains the room headlessly (Work page, strip) and the
runtime reads its Yjs text. Surfaces read the state with `useReviewState`;
nothing copies it into the controller.

Every `ReviewChange` carries the frame it was listed from. A click acts on that
frame: Apply sends its snapshot, Discard finds its pin and content hash in the
current text and refuses when it cannot. Painting may be newer than chrome; that
never changes what a click on older chrome means.

## Discard

`draft-discard.ts` composes the clicked group, applies it to the draft blocks and
writes in one transaction under the editor's own undo origin, so that editor's
`Y.UndoManager` restores it with one Ctrl+Z. Discard draft sets the draft blocks
to the base blocks. A surface with no editor does the same through
`room-discard.ts` (`useHeadlessDiscards`): its own `Y.UndoManager` and a lease on
the room last until the row's Undo or the writer leaves. Only item Discard and
the Work page's Discard are server commands; they close the item or draft.

## Apply

Apply merges the change into live's current text. Scope `"change"` sends
`apply-changes` with the change ids and the `Y.encodeSnapshot` of the projection
the writer clicked, after the server holds every update it contains; scope
`"item"` sends `apply`. Apply all sends listed items with no snapshots (staging is
consent). One lifecycle per draft (`draft-command-record`,
`draft-command-executor`) serves every entry point; the claim is taken at the
click and a preparation failure lands on that draft's row.

- Changes leave the screen at the click, bound to the clicked frame. Ids are not
  identity: an entry or failure names a change by pin plus content hash, and a
  confirmed entry retires when the review's base differs from the clicked one.
- A failure restores the changes with the reason on them; an Apply still out
  keeps the draft "completing", never "No changes left".
- Failures are classified from typed status evidence, never message text.
  Unknown (sent without an answer) never reports success or closes a review.

## Draft-only lifecycle

A new document has server document/Yjs state without live catalog membership.
Its draft-only tab is not persisted and is the document's one workspace tab;
closing review does not discard the draft. Apply promotes through the existing
live presentation only when document, Work and draft match.
`DraftOnlySettlement` observes each represented Work independently of selection:
after list omission a fresh live catalog read decides (membership promotes, fresh
absence closes, a failed read preserves). A gone/404 read is not remote Discard
evidence. The dock persists its review address and one `reviews` entry, and
restore admits the address with the server.

## Durable decisions and verification

- [Diff-based review][editable]
- [Server command authority][authority]
- [Apply is done at server confirmation][confirmation]
- [Late peer recovery][late]
- [Runtime verification recipes](../../../../../../docs/qa/draft-review.md)

[editable]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/diff-based-review-is-the-draft-review.md
[authority]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/apply/command-outcomes-are-recorded.md
[confirmation]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-apply-done-at-server-confirmation.md
[late]: https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/branches/late-peer-recovery.md
