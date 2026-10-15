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
`ReviewState`, joined with the classified attribution and the draft's command
records. Mounted editors attach and paint it (`useInlineReviewSync`); with no
editor `useRoomReview` retains the room headlessly (Work page, strip) and the
runtime reads its Yjs text. Surfaces read the state with `useReviewState`;
nothing copies it into the controller.

Who wrote a change is one classifier (`classifyChanges`, `@meridian/agent-edit/diff`, `attribution.ts`)
over the room's Yjs items and the attribution payload (`review-attribution.ts` joins its answer to
conversations). Three rules, each one sentence:

- **Byline.** A change names an author when, for one of its edits, every alignment the draft's items can
  account for gives that author part of the edit. Under doubt it names fewer, down to none.
- **Membership.** A change belongs to a conversation when any alignment of any of its edits puts one of that
  conversation's AI writes (its own or a subagent's) in it. Under doubt it includes.
- **Status.** An AI part reads applied only when no alignment of any change puts it in a change. Under doubt
  it reads pending.

An alignment is one place the text allows an edit to sit (a repeated word or a boundary space can slide).
Byline is the intersection over an edit's alignments; membership and status are the union. The classifier
works on the character edit of each hunk, never its word tokens, and reads only lengths, ids and
restoration links, so the browser (gc on) and the server (gc off) agree. Authors are identities:
`user(userId)` (the card says "You" while a project has one user) and `thread(threadId, turnId, toolCallId?)`.

Consumers read one answer. The card renders the byline: "You" first (outside the collapsible names, so
hide-mode overflow keeps it), then a link per writing thread. A primary thread's link reveals the write's
turn and tool call; a subagent's write belongs to its nearest primary ancestor conversation (`owner`), the
link carries the parent conversation's title (the subagent's task title is in its label and tooltip), and
it reveals the outermost spawn row. The draft dock, chat-scoped Apply and Discard and the thread
draft-files list read `members` through `owner.threadId`. The arrival pulse reads the byline: a pulse says
an AI wrote this, so an ambiguous author arrives quietly.

Undo of a Discard keeps the chat through restoration links (`restorations.ts`): an item Undo re-created from
a deleted one, proven by equal text over the whole run, the server computing them where tombstone text
exists and the browser adding its own undo stacks'. An Apply appends an Apply record to a server-owned root
of the draft doc in the same write that moves `review_base`, naming the items Apply moved into the base, so
applied AI text reads as base and a stale AI deletion no longer blurs a later point.

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
`DraftOnlySettlement` observes each represented Work independently of selection
and promotes a draft-only tab once the replica shows its document. It never
infers closure from a list omission or a gone/404 read; the item's own command
outcome removes the presentation. The dock persists its review address and one `reviews` entry, and
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
