# QA: text-derived draft review

The writer's own room decides the review. Apply freezes a click; text Discard
is one local undoable edit. Use this recipe on the integration candidate, not
as a record that another branch already passed it.

Ownership: [review runtime and commands](../../apps/app/src/features/draft-review/.context/draft-review.md).
Setup and durable readback: [`./mf`](../debugging.md). Only a browser run proves
what the writer sees.

## Environment and evidence

Start `MODEL_PROVIDER=mock pnpm dev` in the owned checkout. Discover HTTPS
addresses with `pnpm portless:list`. Use `./mf` to create an owned Work, chat
and three-paragraph manuscript, then script one replacement in Draft mode.
Record project, Work, document, item and stable draft ids, commit and viewport.
Use `agent-browser` at desktop and 393 × 852; record whether the phone preset
actually reports a coarse pointer.

Capture screenshots and console/errors. For ordering cells, install a page-owned
request interceptor before the click, filtered to the exact Work/document/id.
Record each frozen body and the request, answer and room-record order. A sleep
alone proves no pending window. Mark an unavailable server seam blocked rather
than simulating it and calling it integrated. Stop the owned browser and stack.

## Review is a function of text

1. Open the change from the chat dock, then from Work Files. Counts, list,
   stepper and paint agree. Removed text is red and struck, new text green.
   Unknown authorship does not hide the change or invent a byline. An empty
   draft paragraph holding a red removal must not also paint “Start writing…”.
   Hide changes: the genuine empty paragraph may show its placeholder again;
   show changes: only the removal occupies the line.
2. Type inside and beside a change, then Ctrl+Z. Paint follows the actual text
   while the 120 ms projection waits. Cut/paste the paragraph and Undo; repeat
   with block drag. Removal widgets never enter pasted manuscript text.
3. Bold a word and change a heading beside a prose edit. Both remain red/green
   changes. A one-character substitution narrows to that character.
4. Edit live in another tab. The draft receives base and prose together. No
   flash, lost focus or stale mark. A scheduled list refresh survives a rebind.
5. Type offline, reconnect, then reload with a held upload. Local text returns
   and eventually reaches server readback. An unopened, never-synced row offers
   no Discard. A previously synced held room can Discard while offline.

## Local Discard and its history

| Action | Required result |
|---|---|
| Discard a change in the editor | Text reverts immediately; Ctrl+Z restores it in one step, with restoration provenance and bylines. |
| Discard the document's whole draft in the editor | Every pending change reverts, draft id stays the same, editor stays in draft review with no changes. One Ctrl+Z restores all. |
| Discard from the dock with no editor | Item leaves at the click; surviving list positions do not move for feedback. Reserved blank footer says Discarded with Undo. Undo restores the same draft and bylines. |
| Dock Discard with editor open, then type a sentence, then notice Undo | Discard is undone, sentence stays; editor Ctrl+Z undoes the sentence, not the dock Discard. |
| Editor Ctrl+Z immediately after dock Discard | It never undoes the dock Discard. Only the notice's Undo owns it. |
| Next dock action, navigation away, reload | Notice and its history end; discarded text persists. No durable dock Revert. |
| AI A's removal discarded, then AI B removes the written-back words | No byline names A. |
| A reply writes through Discard | It keeps writing into the same draft. Later edits are new changes, never a stale-generation refusal. |
| 50k words all changed, then Discard | One transaction/frame, instant notice and count drop, no editor navigation. Record timing and update bytes. |

Repeat the notice cells on Work Files, including an initially opening room and
Undo after the server's pending list has omitted the discarded item. Try a
per-change Discard inside a still-hidden created text document: it is local,
not document removal. Whole-created-document Discard is the next section.

## Frozen Apply FIFO (requires Apply execution)

Each document has one FIFO, one in-flight command; different documents are
independent. Work Apply all sends one frozen click per text draft, never a
Work-wide Apply request.

| Controlled schedule | Required result |
|---|---|
| Two changes in a paragraph clicked successively; three identical changes with the middle clicked while the first waits | Only clicked occurrences leave, immediately. Requests keep the original snapshot, ids and one base-view delta. |
| Apply big black, type furry beside it, Discard before the answer | Applied words stay in the optimistic base; furry reverts. No reversing change. Repeat in the other command order, after groups merge/split and after a structural rebase. |
| Apply big black, delete black and Apply that deletion before the first answer | Base ends at big. The deletion never reappears. |
| Room record before answer, then answer before record | No flicker or duplicate insertion; each head settles once. A record alone is proof. |
| Refuse the middle click | Only its contribution leaves the optimistic base; its change returns with an item failure, then the next frozen click sends. |
| Drop the answer after the request | Same body/id retries after 1, 2 and 4 seconds; then stalled Retry on the item. No successor sends. Retry keeps the same id/body. |
| Slow ten clicks | Every group leaves at once. Applying appears only past 500 ms, in reserved space, for queued clicks as well as the head. Completion order is FIFO. |
| Navigate to Work Files during the head | Owner retains the room, receives answer/record and settles without a mounted editor. |
| Hold the final draft Update on the socket, click Apply, then archive its Work from another tab | Unsent click refuses on the item, leaves no Applying/Retry limbo, and the refused session rebuilds without an owner-binding exception. Reopen the same draft after unarchiving and verify fresh Apply works. |
| Refuse/rebuild the session after a sent Apply loses its answer | Same sent command id stays pending until retry/lookup or the replacement room record settles it; unsent successors tied to the retired session refuse. |
| Reload with two clicks behind a sent head | Sent head may finish; unsent clicks disappear with page memory, their prose returns as draft work. |
| Applied answer, disconnect before record, close from another tab, reconnect | Head settles from its durable answer without waiting for a closed room; queued clicks cancel. No stalled Retry. |
| Live rebase before landing | Both edits survive as the merge specifies; no content-stale refusal or re-cut. |

Also measure retained bytes for ten queued clicks on a 50k draft while typing
10 keys/s. The optimistic fold is cached between base/record/queue changes,
not replayed per key. Record phone handshake costs for twenty Work drafts.

## Removal and terminal closure

- Still-hidden created-document Discard: item leaves, Removed without Undo,
  its tab closes to the Work. A later model write is refused; creating again
  gives a new document id. Reveal before the server lock: refuse with the
  applicable-state reason and re-offer an existing-document row, no false
  Removed notice. A per-change Discard never takes this route.
- Three-tab close race: A reviews an existing draft, B shows its Work Files,
  C keeps the same document open live. B confirms Discard all. A's URL loses
  `item` and `change` and shows the exact document live, without a review-opening
  error or unavailable page, even if metadata `gone` beats the socket close.
  B has an empty pending list and no refusal; C's live prose is unchanged.
  Read live independently and check that the retired `draft:<id>` IndexedDB
  database disappears after all holders release. Repeat with B deleting the
  document: A and C use the existing removal presentation, never another live
  occupant. Failed/unknown metadata or availability reads must not redirect to
  live; restore connectivity and Retry. Reopening an old selector after its
  path is reused must still follow the old document's removal.
- Work Discard all: every item leaves and every bound editor, including an
  empty active draft absent from the pending list, leaves review for live at
  the click. Failure returns the item with its reason, no success notice.
- Another tab deletes the document: live and draft rooms close `4208`, their
  tabs leave, cache is dropped, availability supplies the removal record and
  the notice names its reason/actor. The tab that initiated removal says
  nothing refused. Unsent removed-document text is not retained (accepted
  existence-rule limit, issue #957).
- `4205` (currently `draft-stale-doc`, becoming `draft-closed`) is terminal,
  never a re-fork. Drop that room's cache; go to live. Other-tab closure says
  the draft was discarded; any unacknowledged text is selectable for copying.
- `4409` admission refusal and `4207` missing prefix are not terminal closure.
  Archived Works stay read-only; another draft's command never locks this one.

## Attribution and snapshot-bounded provenance

Use a real mock-model write to an existing manuscript draft; open it from the
Work's Files screen. Capture the `draft/provenance` POST in browser network tools:
its encoded snapshot, project user and AI ranges must cover the visible write,
with owner/reveal metadata for the conversation. A single-user project omits
`writers`, even when unresolved clock ranges are supplied. A wrong Work or
file cannot return evidence; a malformed room or clock range returns 400.

Type locally inside and beside a change: "You" appears without one provenance
request per keystroke. A new remote unresolved range requests evidence; an
Apply/restoration-root revision refreshes it. Disconnect/reconnect and reload:
unknown evidence leaves the text and candidate dock rows on screen without
inventing names. Release the room while an evidence response is delayed, then
open a different room: the delayed response must not publish there.

For #945, remove a paragraph in draft, then edit its live counterpart to
`abc LIVE def`. After the live pull, review must show that full paragraph red,
"You", and enabled Apply/Discard.

- Review groups come from text alone. A mixed-author group stays one row and
  one red/green box even when unchanged text separates its authors' edits.
- Every known byline keeps "You" and at least the first conversation link.
  Names may truncate, but their accessible names and tooltips retain the full
  title. Later conversations go into +N; narrow containers never hide all authors.
- +N opens the remaining conversation links, including their producing-turn
  targets. A subagent link opens its parent conversation at its spawn card.
  Check desktop, phone, and Show changes off (the list still has its bylines).

## Wire checks

`draft/apply` accepts exactly `commandId`, base64 `Y.encodeSnapshotV2`, one
`baseViewDelta` with node JSON, and unique nonempty `groupIds`. Malformed input
and a snapshot whose insertions or deletions are not committed refuse before a
claim. Observe unknown id: none. Landed id survives closure and permission
changes; changed body/scope under the same id is conflict.

The selective server Discard and Work Apply-all routes do not exist. Existing
text Discard sends ordinary Yjs updates only. Server Discard is limited to a
still-hidden creation or Work Discard all. The SQL-only addressed metadata
lookup must resolve empty active drafts without a server preview.

## Addressed metadata and creations without rooms

The addressed GET `…/works/:work/documents/:document/draft?itemKey=…` returns
`active` with the stable draft id, room name and item even after local Discard
makes it unlisted. It returns `gone` for an old item key; a different Work or
project cannot read it. This lookup must not open a Yjs room.

For a hidden creation without a text room (for example a copied image), its
item Apply is available without opening an editor. The click omits `snapshot`
and sends empty `groupIds` and `baseViewDelta`. Verify that it reveals the same
document id, removes the pending item, and a same-id replay returns `applied`.
The same empty click on a text draft or an already revealed item is malformed.
A creation with a text room continues through the ordinary frozen text click.

## Quiet native typing at 50k words

Open a 50,000-word draft with Show changes on and a focused change (so the
controller holds its frame). At the document end, dispatch 40 native `x` keys
at 200 ms intervals. Record CDP frame-sent → applied `SyncStatus` p50/p95;
require 40 applied acks, zero refusals/unacked frames/page errors and +40
characters. Interleave at least three pairs against main with the same
corpus/configuration; record host load and each run, not just a pooled average.
Profile a separate run if the tail regresses: room metadata identity must never
serialize `focus.frame` or any other caller-supplied presentation fields.
Undo the typing, navigate changes, toggle Show changes and Discard a change,
then Ctrl+Z: all must preserve exact prose and restore the review from text.
