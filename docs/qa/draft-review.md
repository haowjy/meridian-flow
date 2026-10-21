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
2. On a long draft, put changes far apart (middle and document end). From
   the top, Next change must scroll the focused passage into the editor pane;
   Previous must bring the earlier passage back. Repeat past both ends to
   wrap, then select either change from the list. Check the passage is visible,
   not just the stepper, `change=` URL and emphasis. Repeat with Show changes
   off and reduced motion enabled, then after switching review documents and
   returning: only the currently presented editor scrolls.
3. Type inside and beside a change, then Ctrl+Z. Paint follows the actual text
   while the 120 ms projection waits. Cut/paste the paragraph and Undo; repeat
   with block drag. Removal widgets never enter pasted manuscript text.
4. Bold a word and change a heading beside a prose edit. Both remain red/green
   changes. A one-character substitution narrows to that character.
5. Edit live in another tab. The draft receives base and prose together. No
   flash, lost focus or stale mark. A scheduled list refresh survives a rebind.
6. Type offline, reconnect, then reload with a held upload. Local text returns
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
| 50k words all changed, then Discard | Row and count leave at the click; Discarded and Undo paint before write-back starts. Write-back is one transaction/frame with no editor navigation. Record click→notice DOM, paint opportunity, transaction duration and update bytes separately. |
| Multiple all-changed files in the dock, then Discard | Every selected row leaves and the final notice paints before any file's write-back. Ending the previous notice must not synchronously flush its pending write. |
| Notice Undo before the deferred transaction starts | The write is cancelled, the row returns and no Yjs update is emitted. |
| Navigate away immediately after Discard | Notice ends, but the retained operation still writes once. Retiring the binding or replacing the account before it starts instead prevents stale writes and releases its lease. |
| Type or receive a peer write before the deferred transaction | Changed prose/base refuses the stale Discard with its item failure; intervening text survives and the row returns. |

On the all-changed 50k-word file, repeat dock Discard and notice Undo **five times**.
Wait for the Discard transaction to finish before Undo (not the early-cancel path);
capture the bound session before each Undo and await its current-changes
acknowledgement. Each action emits one prose transaction and update, every Undo
restores the exact pre-Discard ProseMirror document, and all five barriers resolve.
Record socket closes: `4207` is not an acknowledgement. Reload after the fifth
barrier and compare the same text; local restoration alone does not prove durability.

After Apply, type an extra word outside a replacement, then Discard that
insertion and Undo. Repeat with the document's Discard draft while only
insertions remain. Neither action nor Undo raises a schema-repair notice;
restored text is green. Also check Redo and repeated Discard/Undo. As a positive
control, apply a foreign Yjs update containing an unsupported `sidebar` node to
the bound room: the binding removes it and still shows a live repair notice
with the recovered prose. Do not fake the notice or insert and remove the node
in a single local transaction.

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
| Refuse an Apply for a reason other than archive (page-owned `fetch` answering `{status:"refused",reason:"not_found"}`) at 1440x900, 900x900 (bar between paragraphs) and a coarse-pointer 390x844 phone; repeat in Work Files with the file expanded | The failure shows exactly once: on the focused change's bar (in place of its byline when the bar sits between paragraphs), under the identity row only with Show changes off, in the file's status line on Work Files and the dock. Paragraph and row tops are unchanged before and after. |
| Drop the answer after the request | Same body/id retries after 1, 2 and 4 seconds; then stalled Retry on the item. No successor sends. Retry keeps the same id/body. |
| Slow ten clicks | Every group leaves at once. Applying appears only past 500 ms, in reserved space, for queued clicks as well as the head. Completion order is FIFO. |
| Navigate to Work Files during the head | Owner retains the room, receives answer/record and settles without a mounted editor. |
| Hold the final draft Update on the socket, click Apply, then archive its Work from another tab | Unsent click refuses silently: the change returns without Apply/Discard under the archived notice (also on a coarse-pointer phone), with no failure line anywhere and no Applying/Retry limbo, and the refused session rebuilds without an owner-binding exception. After Unarchive no stale refusal remains; reopen the same draft and verify fresh Apply works. |
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
the byline of whoever removed it, and enabled Apply/Discard.

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

## Burst allocation and peer paint

Use a 500-paragraph, roughly 50,000-word draft with 100 separated changes.
The [preserved burst harness][burst-harness] seeds this fixture and drives the real
browser command owner with two independent 10-key/s room clients.

1. Observe a peer key before the fresh review projection. Unchanged small green
   ranges stay small and in place; no range expands over the whole manuscript.
2. Capture 100 Apply clicks without waiting for prior answers. Every captured
   group leaves the review, each body stays frozen, and only the head dispatches.
   After captures stop, queue depth falls to zero and queue-held operands release.
3. Record request bytes, first/tenth/hundredth click-to-terminal times, browser
   resident/swap/high-water counts and both senders' durable acknowledgement counts
   against the work item's unchanged budgets. Do not call a capped or interrupted
   run passing. Profile allocations separately from latency runs.
4. Discard the sole change, then Ctrl+Z. Its prose, review group and enabled Apply
   control return together. Repeat after navigating away and back to the draft.
5. With unchanged toolbar availability, review paint/focus updates must not rebuild
   the toolbar. Center-to-right alignment and Undo/Redo still update its real state.

[burst-harness]: https://github.com/haowjy/meridian-flow-docs/tree/main/work/diff-based-review/b/burst/harness

## Quiet native typing at 50k words

Open a 50,000-word draft with Show changes on and a focused change (so the
controller holds its frame). At the document end, dispatch 40 native `x` keys
at 200 ms intervals. Record CDP frame-sent → applied `SyncStatus` p50/p95;
require 40 applied acks, zero refusals/unacked frames/page errors and +40
characters. Interleave at least three pairs against main with the same
corpus/configuration; record host load and each run, not just a pooled average.
Profile a separate run if the tail regresses: room metadata identity must never
serialize `focus.frame` or any other caller-supplied presentation fields.
Repeat in a Work containing an untouched all-changed 50k sibling draft with
Discard/Undo history. After initial room/evidence discovery settles, same-membership
typing must make no Work-list or addressed-metadata requests. A new frame/group id
alone must not run the server's whole-Work disposition reader. First/last change,
Undo and changed AI membership still refresh discovery, as does a real independent
live-room update. An editor mounted in review must not also be a live refresh source.
Queued Apply heads update local paint/counts immediately, but only the drained
item's outcome refreshes its list. Notice, failure and pending feedback update at
rendering leaves without rebuilding the project file tree.
Undo the typing, navigate changes, toggle Show changes and Discard a change,
then Ctrl+Z: all must preserve exact prose and restore the review from text.

## Sustained server retention

Use one 500-paragraph, 50k-word fixture across the whole run: two independent
open-loop senders at 10 keys/s, with 176 one-paragraph live edits/rebases followed
by 39 fifty-paragraph live edits/rebases. Wait for every key's durable ack and
verify the review base equals live. Do not reseed between operations: fresh
fixtures hide retention of superseded append replicas.

Sample **the Nitro worker**, not its parent process, with a worker-local inspector
`HeapProfiler.collectGarbage` followed by `process.memoryUsage()`. Record initial,
10, 176 and 215 operation cuts and a drained cut. Snapshot in a separate run:
snapshots pause the worker, queue more typing and distort per-operation measurements. Compare
current encoded document bytes alongside post-GC heap. Gc-off tombstones grow with
changed text and survive checkpoint folding; old whole-document replicas and
append callbacks must not accumulate. Inspect root-to-retainer paths rather than
inferring a leak from process RSS. Never raise the worker's heap limit to pass.

The reproducible incident, isolated encoding-lifetime fix, heap snapshots and
harness setup are recorded in the [OOM investigation][draft-review-oom].

[draft-review-oom]: https://github.com/haowjy/meridian-flow-docs/blob/158e2c97e912ecf5856acdd7de1a2afa702c70ea/work/diff-based-review/b/oom/REPORT.md
