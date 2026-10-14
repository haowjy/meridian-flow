# Draft review reference

[The ownership map](../AGENTS.md) identifies modules. Paths are relative to
`apps/app/src` unless noted.

## The model

An item's text branch room holds two fragments: `review_base` (the live
text as of the branch's last rebase; the server advances it, so it is not the creation snapshot) and `prosemirror` (the item's text). The review is
`projectReview(diffBlocks(base, draft))` from `@meridian/agent-edit/diff`,
recomputed in the browser whenever either fragment changes. Group ids are
content hashes (equal hashes get a `~n` suffix). An empty `review_base` is a
real base once the room has synced (the editor reports `ready` only after sync
or when at least one change exists).

One review runtime per draft room (`review-runtime.ts`) publishes an immutable
**frame** (`review-frame.ts`: diff and groups, `Y.Snapshot`, each change's pin) in a
`ReviewState` (frame, changes, ready, plus the visible changes with their failures
and the applied entries in force). The runtime joins the frame with the chats the
attribution hint names (one query observer per room) and the draft's command
records (watched once), and derives that state itself; readers select from it.
Mounted editors attach to it (`useInlineReviewSync`): the runtime projects the first
attached editor's text and paints every attached editor with the frame, and each
attachment has its own command handle (`editorHandle(editor)`) so a Discard is
authored into the history of the editor the writer clicked in. With no editor, `useRoomReview` retains the branch room headlessly (Work page,
expanded strip) and the runtime reads its Yjs text. Both share one runtime, one
debounce and one base read. Command records are reconciled once, in the runtime, on
each ready frame, after the painters have the frame: a typing frame is painted first and
settled (records, visible state, readers) in the next microtask, and a settle that changes nothing
wakes no reader. Surfaces read the state with `useReviewState` (`useChangeItems`
turns it into rows); nothing copies it into the controller.

Every `ReviewChange` carries the frame it was listed from (`change.frame`, `change.pin`).
A click acts on that frame: Apply sends its snapshot and pin, Discard finds its pin and
hash again in the current text and refuses when it cannot. Painting may be newer than
chrome (the painter maps edits lazily, `currentReview`); that never changes what a click
on older chrome means.

## Discard

`draft-discard.ts` composes the clicked group (`composeGroups(…, "discard")`),
applies span patches to the draft blocks and writes them in one
`doc.transact(…, origin)` with the editor's own undo origin. Only that editor's undo manager tracks it
with `stopCapturing()` on both sides, so one Ctrl+Z restores the change.
Discard draft sets the draft blocks to the base blocks. Identity: each
projection pins every change's first mark as a Yjs relative position; Discard
re-projects and matches by pin position plus content hash (ignoring `~n`).
No match is a no-op. A group adjacent to an AI deletion is one group, so its
Discard reverts the deletion with it.

A surface with no editor (strip, Work rows, the phone's bar, sheet and header) does the same edit through `room-discard.ts`:
`useHeadlessDiscards` (the phone's one open review scopes it by `documentId:itemKey`, so its rows end with that review; the header's Discard draft is `discardAll`) writes the discard with an `Y.UndoManager` that tracks
only it and keeps a lease on the room until Undo, and the row reads "Discarded" with Undo until
the writer leaves. Item Discard (a created, binary or live-deleted item; `discardDraftItem`
sends `{draftId, itemKey}`) and the Work page's Discard all (`discard_draft`) are the only
server Discards; they close the item or the draft, and a later write opens a new text branch
with a new room name.

## Apply

Apply is content Apply: the change merges into live's current text. The client's
`ApplyCommand` has scope `"change"` (named changes of one item, wire `apply-changes` with
`{draftId, itemKey, commandId, changeIds, snapshot}`) or `"item"` (wire `apply` with an
optional `snapshot`). Apply all sends the listed items with their `locationToken`s and no
snapshots: the server applies each as it stands when it stages (staging is consent).
`snapshot` is a base64 `Y.encodeSnapshot` of the projection the writer clicked in: an open
editor's projection and a listed row's room projection each carry their own snapshot,
chosen by the click and never read at send time. Item results: `applied`, `already_live`,
`held`, `not_found`, `failed` (with a reason), and on the item routes `stale`, `whole_item`
and `gone`; `stale` is the item's location moving, never live text moving.

Apply is one lifecycle per draft (`draft-command-record`, `draft-command-executor`),
used by every entry point (card, stepper, Apply draft, strip row, Work row, Apply
all). The claim is taken at the click; `prepare` (metadata fetch, room sync, snapshot)
and `whenAcknowledged` (the server holds every update the snapshot contains; a timeout
fails the Apply as not sent, it never certifies) run inside it, so a preparation
failure lands on that draft's row.

- Changes leave the screen at the click (`AppliedChange`, shared by the lists and the
  manuscript's marks). An entry is bound to the clicked frame: its id, its Yjs pin
  and the `review_base` it was computed against. Ids are not identity (`h`, `h~1`):
  an entry, and a failure, name a change by pin plus content hash (`isSameChange`), so a
  twin that inherited the id is never hidden or blamed, and retirement follows the base:
  a confirmed entry retires when the review's base differs from the clicked one.
- A failure restores the changes with the reason on them. An Apply still out keeps
  the draft "completing", never "No changes left".
- `applied.overrode` is published per draft and shown, with the same copy, on the
  open review, the strip row and the Work row.
- Whole-item Apply holds one claim per item (`beginDraftCommand`).

## Surfaces

Cards, stepper, strip, Work page and chip read `ReviewChangeItem`s. `change.chats` names the
chats whose AI edits overlap a change: the server lists each draft's pending edit parts as Yjs
item ranges and `matchAttribution` tests them against the draft's text. Deletions attribute at
block granularity and writer edits are never named. The strip keeps this chat's changes the same
way and Applies them; arrival pulses mark changes that show up while the writer reviews.
