# Draft review

This page defines the chat-side review session, pending projection, freshness,
and draft-only-tab contracts.

## Architecture

Inline review is the only manuscript preview surface. Whole-draft Apply
publishes the whole current draft. Per-change Apply and Discard act on one
change, a server closure class, sent with every operation of the class; the
change leaves every surface at once and a refusal brings it back with its reason
(see "Per-change commands" below). There is no per-change Undo.
The controller is the single client review-session owner. Its reducer owns
`surface: none | inline`, the active `{ documentId, draftId }`, and inline
messages. The synchronous disposition lock and the shared draft
command record (below) are the pending-command sources. Use controller transitions instead of pairing
local `close` calls; `exitReview` is the single clear-all path.
`DraftReviewProvider` is the convenience boundary for one Project + Work owner.
The project shell uses its lower-level split directly: it creates one persistent
Chat value (with thread authority) and one persistent Editor value (without
thread authority), then re-provides those values at sibling boundaries. The
stable Chat surface and Chat context dock share the same Chat value; viewer and
editor surfaces receive only the Editor value. A boundary never creates a
controller, and the two scope owners are never nested.

Every disposition is serialized by the session's synchronous lock and, for the
draft itself, by its one command record (`client/query/draft-command-record`,
below): while a whole-draft Apply or Discard, or a per-change Apply or Discard,
is in flight, all mutating controls disable (`controller.isDisposing` reads the
Work's records, so the Editor's and the Chat's scopes see each other's commands)
and a second command is refused rather than clearing the in-flight state. A
per-change Discard routes to the server discard mutation with the change's
`operationIds` and the preview's revision tokens; the server performs
reversal-peer sync. Whole-draft Discard sends neither. The mutation awaits the
draft-list and preview refreshes before the session releases its lock, so no
second preview-settlement timer or local pending copy is needed.

### Per-change commands

`DraftReviewSession.applyChange` and `discardChange` run one change. Each claims
the draft's **command claim** (`beginDraftCommand` with the change and its
operation set: one command per draft, whichever session sends it) and a **change
command record** (`client/query/change-command-record`, keyed by the draft and
the change's class id, matched by shared operations) for what outlives the claim:

- `pending`: the draft's own claim. The change is already gone from the preview
  every surface reads (`useDraftPreview` hides it), so its marks and rows leave
  at once. The change record stores no pending state of its own.
- `confirmed`: the server confirmed. The cached preview loses the change
  (`settleConfirmedChange`) and a preview read that started earlier cannot bring
  it back (`readPreviewAfterChangeCommands`).
- `failed`: the change comes back, with `offline` (the server refused it:
  "Couldn't apply. Check your connection and try again."), `unknown` (an Apply
  that got no answer: "Couldn't confirm whether this applied", never inferred
  from later list membership), `stale` ("This change was updated. Check it and
  apply again." / "...discard again.") or `draft-only`, shown on its bar and row.
  `gone` is not held: the change leaves with a toast. `incomplete_class` is
  treated as `stale`, for Apply and Discard alike.

Apply and Discard send the live and draft revision tokens of the cached preview
the writer saw (opaque strings), so a change updated under them is refused,
never applied or discarded. Only an answered `discarded` / `applied` reaches
`settleAnsweredCommand`; a `stale` Discard says nothing about the draft.
The toast ("Applied", "Discarded", "That change is no longer in the draft.") is
controller state (`toast`), rendered by `ReviewToast`. The server closes a draft
in the command that handles its last change (the response carries `draftClosed`
and `draftDisposition`), so the draft leaves the Work's list. The controller
settles the review from that answer, ahead of the list and preview re-reads
(`onAnswered` on the mutation), through `inlineReview.completion`:
`pending` from the click when the command handles the last change (a last
Discard also holds the finished text inert), `closed` on `draftClosed: true`,
withdrawn on `draftClosed: false` or a command that did not land. The last
change is the one every other remaining change (unclassified hunks and
non-actionable classes included) leaves nothing beside. "No changes
left" with Next draft (Back to live when no draft is left) is `closed` only; a
`pending` completion says "Applying" or "Discarding". Neither the provider's
"draft left the list" exit nor the address owner ends a review that has a
completion. `EditorView` shows the warm live editor in place of the review editor
for a last Discard at the click (inert) and, editable, once `closed` (the draft
equals live; the review room is a closed generation and its reset would otherwise
show doubled text); a last Apply keeps the review editor until `closed`. After a
reload the draft is not listed and the address falls back to live.

Focus is controller state too (`inlineReview.focusedClassId`,
`focusReviewChange`). `useInlineReviewFocus` (in `EditorView`) syncs it, Show
changes (`marksVisible`) and the pulse on arrivals with the editor, and reports
a click on a mark back. The stepper, the bar and the dock list read it from
`useReviewChanges`.

An archived Work's drafts are frozen (D30): the server refuses Apply and
Discard. The controller's `dispositionLocked` (frozen drafts, from the
scope's Work, or a disposition in flight) disables every disposition control
beside the existing archived notice; Review stays available. A new disposition
control reads the same flag.

Bulk Apply/Discard is one controller command over a captured target list; the
dock does not infer command completion from busy/idle render edges. Whole-draft
Apply addresses the current branch rather than preview operation ids or a
revision token. The server settles the complete branch state at command time,
including writer rows created after the last preview. For whole-draft Apply the
client therefore treats preview operations and revisions as evidence, not
command scope; per-change Apply is the one command that sends them. Apply/Discard failures
are session outcomes rendered by the review header rather than ignored
promises. A batch stops at its first failure or unknown outcome; transport
failures surface through the dock's typed error state.

Cross-cutting server policy:
[whole-branch Apply](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/apply/draft-apply-whole-current-branch.md)
and
[live-only sweep projection](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/concurrent-safety/trail/ai-change-event-projections.md).

On Apply or whole-draft Discard, the controller clears the review surface so
the editor rebinds from the review branch room to the live manuscript room. The server
owns one active Work-draft branch per `(documentId, workId)`, so there is no
same-document neighbor to select after disposition. Whole-draft Apply has one terminal
`applied` result; partial-Apply and stale-preview response states exist only for
per-change Apply and Discard (`applied`/`discarded`, `stale`, `gone`,
`draft_only`, `incomplete_class`).

`EditorView` keeps a document's live editor mounted, hidden, underneath its
review editor. Entering review keeps the live text on screen, read-only from
the click (the host passes the intent before the room resolves), until the
review room has bound and its editor exists, then swaps in one step; Apply, Discard and
Back to live reveal the warm live editor instead of rebuilding one. No review
transition shows an empty body. A draft-only tab has no live editor to keep, so
its shell (or schema notice) is visible from the first render. The controller's
room request belongs to the review that started it: closing review A as launch B
opens (same effect flush: the address owner exits A, the claimant enters B) must
not cancel B's request, or B waits forever for a room (the draft-only editor
that stayed empty under a "Review draft" chip). The request is the one fenced
preview query (`draftPreviewQueryOptions`, read fresh), not a second raw fetch:
it joins any read in flight, a change handled while it was in flight cannot come
back through it, and a review that moved on commits no room. The review editor
is keyed by its own branch room, never by the live binding, so a rename (which
re-mints the live binding) does not remount the painted review.

Entering review holds the plain live view, header included, until the review
editor exists and its change marks have arrived, then switches body and chrome
in one frame. `EditorView` reports `shown` on the inline surface
(`controller.setInlineReviewShown`, from a layout effect); the header and the
identity-bar chip read it. The live text is read-only from the click. If the
marks never arrive the review shows anyway after 1.5 s. Measured: zero frames of
review header over live text and zero blank frames on enter, Back to live, Apply
and Discard
(`work/draft-review-repair/evidence/redesign-render/`).

When the server refuses a review room's pending edits (4409), the room is
rebuilt in place and the review stays open. While the rebuild runs, `EditorView`
shows an inert copy of the painted review (`FrozenReviewMarkup`), detached from
input before the retired Y.Doc is destroyed, so neither live prose nor an empty
shell appears under a review the writer is still in. The copy belongs to one
review identity (document, room, draft) and one rebuild attempt: it renders for
no other review, and a retired attempt's completion or failure is ignored. Do
not keep the old TipTap view mounted instead; the registry destroys the reset
branch's Y.Doc, so that would need a new detach-and-retain contract.

Review mode is a full-width Editor; the dock remains in the writer's chosen
open/collapsed state and view. There is no in-editor review split.
`useAiDraftLauncher` submits an explicit Work/document/
draft/path command to the route-level Editor handoff rather than commanding the
ambient Chat controller. The handoff holds one provider-lifetime, latest-wins
intent, navigates atomically to its Work and manuscript path, and lets the
Editor boundary claim it only after the route command succeeds and route Work,
path, mounted document, and active draft membership all agree. Pending and
rejected commands are never advertised to the claimant. This owner sits above desktop/phone shell
selection, so a phone Chat-to-Editor transition cannot destroy the intent or
either scope controller. The phone document host publishes its resolved editable
document to that Editor value and binds the selected review room back into its
read-only `EditorView`, just as the desktop host binds its active editor. The editor's review chrome is
`features/editor/DraftReviewHeader` (above the identity bar, review-only), one
row: `Manuscript /`, the draft switcher (the Work's drafts with change counts,
Show live version or Close review, Apply all and Discard all), the stepper,
Show changes, Discard draft and Apply draft, all delegating to the controller.
Apply draft and Discard draft open the next draft in the switcher at once (or
leave the review for live when none is left). The server owns one active Work-draft branch per
`(documentId, workId)` and aggregates every contributing thread into that
branch, so review has one active row per document. The dock's `DockChangesView` lists the reviewed document's changes, one line
each (`features/draft-review`), read from the live preview through the **Editor
scope's** controller (`useEditorDraftReview`); the dock sits in the Chat's
boundary, whose controller never has a review open. A row's Apply and Discard
take their selection from review state, so they work with no manuscript
mounted. Only focusing needs the editor: `controller.focusReviewChange` reads
the review editor off the inline-review runtime to emphasize and scroll to the
change, and is inert on screens with no editor.

The review editor is editable. A draft branch is a Yjs room and the writer is
one more peer in it, so ordinary TipTap input is admitted and lands in the draft
branch — never in live — alongside agent writes. Dispositions are separate:
Apply/Discard are server commands, so draft review has no per-change Undo
command. After Apply, recovery belongs to turn-receipt Undo/Redo rather than
peer-mark actions, browser Ctrl+Z, or a client mutation origin.

`useInlineReviewSync` is a plugin adapter only: it pushes server hunk models into
the TipTap inline-review extension and reports model availability identities. It
pushes every refetched preview (compared by reference), not by revision tokens:
`draftRevisionToken` is the branch generation and does not move on edits.
The extension renders the net diff in the manuscript like suggestion mode:
insertions as decorations over the draft text, removed live text as a read-only
inline widget (struck, outside the document; AI crimson, writer gold; long ones
fold and open on click), and the focused change (all operations sharing a
closure class) emphasized. Typing paints gold at once; the next model replaces
it. `setInlineReviewMarksVisible` hides all marks without remounting. An active
preview without a model is an invariant violation, logged loudly and ignored safely.

The server reviewable list emits only current-generation drafts with reviewable
content. `pendingReviewDrafts` is the shared client presentation seam that
filters rows without review content and orders the remaining drafts for the dock
and inline-review launcher. Branch lifecycle status is not review evidence: a
reusable manifest branch may remain active while carrying only bookkeeping.
Closed lifecycle rows, bookkeeping-only branches, and draft-level Undo receipts
are not part of this boundary.

Apply and Discard outcomes, the command record, and the rejected post-Apply
recovery protocol are recorded in
[Draft Apply Is Done When the Server Confirms It](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/draft-apply-done-at-server-confirmation.md).
See the
[requirements doc](https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/requirements.md)
for product decisions and the
[editable draft review authority decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/draft-review-editable-branch.md)
for cross-cutting architecture.

The preview describes the branch-vs-live delta and supplies navigation evidence;
it does not scope Apply. Apply always settles the server's current branch.

## Draft review freshness

`DraftReviewProvider` owns the client cache freshness contract for mounted inline
reviews. When an inline review has a mounted review `DocumentSession`, any Yjs
update in that branch room invalidates both:

- the active draft preview query, so the editor rail/hunks re-derive from the
  latest server review model; and
- the work draft list query, so the composer dock reflects updated draft counts
  without closing and reopening review.

This subscription is a freshness seam only. The TipTap/Yjs session remains the
single document-sync path; the provider never interprets update contents or builds
a second draft model.

Preview refresh remains presentation freshness for whole-draft Apply, which
sends no revision token or operation set; the server branch is its command
authority. Per-change Apply sends the tokens it was shown, and refreshes before
the next command so the tokens are current. New AI writes during review reach
the list and the marks through this same refetch: the count rises, the new row
and marks pulse once (not under reduced motion), and nothing the writer applied
or discarded comes back from a stale read.

## The pending signal and draft-only tab lifecycle

**One client pending projection; one server authority.**
`pendingReviewDrafts(group)` in `client/query/useWorkDrafts.ts` is the
per-document client "has changes to review" derivation. `pendingReviewDraft`
selects its newest draft, while `activeWorkDraftGroups` projects all pending
groups once for composer surfaces. The dock's pending rows, the identity bar's
`DraftReviewChip` (self-contained; hides itself during that document's inline
review so it never coexists with `DraftReviewHeader`), and the mode selector's
fast-path count all derive from this filter. Never grow a second client
is-pending derivation.

The client projection never authorizes Draft → Auto-apply. The server's
`work-draft-pending` classifier independently supplies the review list,
authoritative content-branch count, and confirmed apply plan. Keeping those
server operations on one classifier prevents the shipped disagreement where the
dock showed no reviewable change but the mode-switch dialog raw-counted one
manifest journal row.

Pending membership and presentation order are separate contracts.
`dockRows` builds its own list sorted by `documentName ?? documentId` for the
DraftDock and the Changes view; it must not reorder the shared projection.

**Draft-only tabs.** A NEW document proposed by a draft is real (documents
row + Yjs state) but absent from the live tree until Apply, and the server
refuses a live room for it, so review hosts the draft branch room alone: the
desktop host opens no live binding for a `draftOnly` tab. The ordinary live room
opens once Apply promotes the tab. There is no live version to go back to, so the
header's exit for such a tab reads "Close review" and closes the tab (the draft
stays in the Work's list to reopen), and a failed branch room offers Retry or
closing the tab rather than falling back to an empty live editor. The phone
hosts it the same way: the route finds the draft-only tab through the shared
route-document order (`features/project/context/route-document-owner.ts`), and
`MobileDraftOnlyDocumentHost` delegates to the desktop `ContextEditorMountHost`
without acquiring a live room. Its review tab
is synthesized by the launcher (`context-tab-from-draft.ts`) and marked
`draftOnly`, from the server's `isNewDocument` flag — derived per list
request from manifest membership (in the work manifest, not the live one),
never stored. The launcher's `openTab` puts it in the review overlay;
`ContextRemovalCoordinator` alone closes or promotes it, and checks the owning
Work and exact tab instance before changing the workspace.
The synthesized tab carries that transient `reviewWorkId`; it is not document
location identity and is never persisted. A different Work reviewing the same
project document therefore cannot resolve this Work's draft-only tab.
Readable-address admission for that same server document keeps the synthesized
review member authoritative; it must not create a durable tab hidden underneath
the review overlay, regardless of whether address or review admission arrives
first. Review admission absorbs an earlier durable member; later address
admission may enrich only the overlay with resolved live-resource metadata.

- **Apply.** Apply is done when the server confirms it. Nothing later can undo
  it: there is no recovery protocol and no Finish/Abandon workflow. At
  confirmation the mutation records the draft as confirmed (see the command
  record below) and removes it from cached pending membership, the session exits
  inline review, and the command returns `applied`, so a bulk Apply advances at
  once. Promoting a draft-only overlay to a durable tab
  (`promoteAppliedDraft`: keep the tab, drop the marker) and repairing the route
  run on after that and never decide the result; the provider's remote
  classification promotes a tab that was missed. The ordinary live-document host
  then shows "Connecting", its own disconnect state, or its retryable open
  error, exactly as for any document.
- **The draft command record.** `client/query/draft-command-record.ts` holds one
  record per draft (project, Work, documentId, draftId), outside any review
  scope, so every surface (composer strip, editor header, Work Files) reads the
  same state. It is bounded: `bindDraftCommandAccount` empties it when the
  account changes, and the entries below retire as described.
  - `pending`: an Apply or Discard is dispatched, whole-draft or one change with
    its operation set. `controller.isDisposing` is the
    scope's synchronous lock or a pending record in the controller's own Work, so
    every surface of that Work disables while other Works and projects stay
    enabled, and a second command for the same draft returns `blocked` instead of
    being sent. The session releases the claim whenever it ends without a
    confirmation or a held failure, including when an optimistic callback throws
    before anything is dispatched.
  - `confirmed`: set by `useApplyDraft` at server confirmation. Draft-list reads
    that started before it (`readDraftsAfterCommands`, applied in
    `useWorkDrafts`'s query function) cannot bring the draft back; a read that
    starts later is authoritative, since the server reuses a draft id for a
    branch's next generation. The record is dropped once no earlier read is still
    in flight. The list then refreshes in the background.
  - `failed`: a rejected Apply (`apply-failed`), a refused Discard
    (`discard-offline`), a lost Apply response (`apply-unknown`), or a Review launch that could not open
    (`review-failed`, recorded by the editor handoff and never over a pending
    command), shown on the draft by the header, the composer strip, the Work
    Files row, the Changes view, and the identity-bar chip (which turns into a
    retry). It clears on the next action on that draft (Discard
    retry, Apply, opening Review); Work Files also offers Dismiss. A later list read
    that no longer lists the draft drops it too, so it never reaches a later
    proposal that reuses the draft id.
- **Rejected and unknown Apply.** A response with a status is a rejection
  ("Couldn't apply", never the confirmed path). A request that got no answer is
  unknown ("Couldn't confirm whether this applied"), whatever the list shows
  next: the draft leaving the list is not evidence of Apply, because another
  browser's Discard looks the same, and a draft still listed is not proof of
  rejection, because the server may still be committing. Nothing infers a result
  from the list, so unknown never claims "Applied" and never promotes a
  draft-only tab. When the draft is gone the row simply stops rendering, review
  exits, and the document view shows whatever is live.
- **Optimistic Discard.** Whole-draft Discard calls `discardDraft` when the
  command starts. It closes the tab with the ordinary adjacent-tab/empty-Editor
  fallback and repairs the address in place. A refused Discard never reopens
  the tab and never navigates: the draft is still pending, so the error shows
  on the draft itself (below). Header, composer-strip, and bulk Discard share
  this lifecycle.
- **Confirmed and remote Discard** call the same `discardDraft`, even when no
  local tab remains (a no-op then). It never creates or restores a tab.
- When a draft-only tab's draft leaves the active list without a local
  disposition (another browser applied or discarded it, or an Apply response was
  lost), the provider takes a live-manuscript catalog observation that starts
  after it saw the draft leave (`acquireCatalogAfter`; joining an older in-flight
  acquisition could report the pre-Apply tree). Membership means the document is
  live and the tab is promoted; absence means a Discard and the tab closes. A
  failed read leaves the tab intact. The tab and the catalog are the whole
  evidence: no account-level witness is kept. The list only leaves when it is
  re-read, and a page that did not dispose has no mutation to invalidate it: a
  pulled catalog wake hint (`pullContextCatalogOnHint`) re-reads the project's
  mounted draft lists, and an Apply or a Discard of a new document both move the
  manifest, so the other page settles within about a second without a reload.
- Draft-only tabs live only in the review overlay. The durable workspace never
  opens, persists, or restores one, and route continuity (the removal planner's
  route target and fallback) skips them, so a discarded path can't replay on
  the next visit. Only Apply promotion drops the marker; a later `openTab` for
  the same document enriches the overlay instead. The coordinator repairs the
  route when disposition removes the route-active tab.
- While a local disposition is in flight the provider does not classify
  remote ones.

Server-side twin: discarding a new-document draft also removes its entry from
the work manifest branch. Later Apply operations publish the manifest as well as
document content, so a discarded entry must not remain in that branch.
