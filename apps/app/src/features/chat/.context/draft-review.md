# Draft review

This page defines the chat-side review session, pending projection, freshness,
and draft-only-tab contracts.

## Architecture

Inline review is the only manuscript preview surface. Apply is a document-level
command that runs the whole-current-branch `acceptDraft` path; Discard may still
target one operation or the whole branch.
The controller is the single client review-session owner. Its reducer owns
`surface: none | inline`, the active `{ documentId, draftId }`, and inline
messages. The synchronous disposition lock is the
only pending-command source. Use controller transitions instead of pairing
local `close` calls; `exitReview` is the single clear-all path.
`DraftReviewProvider` keys that owner by Project + Work so review and dock-error
state cannot cross a Work switch.

Every disposition is serialized by the session's synchronous lock
(`controller.isDisposing`): while document-level Apply or per-card/whole-branch
Discard is in flight, all mutating controls disable and a second command is
ignored rather than clearing the in-flight state. Per-card Discard routes to
the server discard mutation with
`operationIds`; the server performs reversal-peer sync. The mutation awaits the
draft-list and preview refreshes before the session releases its lock, so no
second preview-settlement timer or local pending copy is needed.

Bulk Apply/Discard is one controller command over a captured target list; the
dock does not infer command completion from busy/idle render edges. Apply
addresses the current branch rather than preview operation ids or a revision
token. The server settles the complete branch state at command time, including
writer rows created after the last preview. Apply/Discard failures are session
outcomes rendered by the review header rather than ignored promises.
A batch stops at its first failure; transport failures surface through the
dock's typed error state. Apply always merges through Yjs, including when the
writer changed the same passage after the draft was cut. The durable receipt
preserves each branch row's actor attribution. Active AI handles retain their
normal live Undo dependency semantics; writer rows may therefore make an AI
turn Undo unavailable. Best-effort sweep evidence only elevates a receiving
writer's swept mark when that writer's post-observation edit was overwritten.

On Apply or whole-draft Discard, the controller clears the review surface so
the editor rebinds from the draft room to the live manuscript room. The server
owns one active Work-draft branch per `(documentId, workId)`, so there is no
same-document neighbor to select after disposition. Apply has one terminal
`applied` result; partial-Apply and stale-preview response states do not exist.

Review mode is the dock's `Changes` view, plus a full-width editor when the
writer is on the Editor screen — there is no in-editor review split. Entering
review never changes `?screen` (`useAiDraftLauncher`): Changes is a dock view on
every screen and its cards read the server preview, so review opens where the
writer already is. The editor's review chrome is
`features/editor/DraftReviewHeader` (above the identity bar, review-only): LEFT
"Back to live" exit and RIGHT whole-draft "Apply all" / "Discard all", all
delegating to the controller. The server owns one active Work-draft branch per
`(documentId, workId)` and aggregates every contributing thread into that
branch, so review has one active row per document. The dock's `DockChangesView`
expands the reviewed document to operation cards read from the live preview.
Each card carries one hover-revealed Discard verb, the only mutating target on
the card, driving `controller.discardOperation`. Whole-branch Apply remains in
the review header so the UI cannot imply operation-scoped acceptance. Discard
takes its selection from review state, so a card disposes correctly with no
manuscript mounted. Only the card-body click needs the editor: it calls
`controller.focusReviewOperation(operationId)`, which reads the review editor off
the inline-review runtime to highlight + scroll the manuscript span, and is
inert on screens with no editor.

The review editor is editable. A draft branch is a Yjs room and the writer is
one more peer in it, so ordinary TipTap input is admitted and lands in the draft
branch — never in live — alongside agent writes. Dispositions are separate:
Apply/Discard are server commands, so draft review has no per-card Undo command.
After Apply, recovery belongs to turn-receipt Undo/Redo rather than peer-mark
actions, browser Ctrl+Z, or a client mutation origin.

`useInlineReviewSync` is a plugin adapter only: it pushes server hunk models into
the TipTap inline-review extension and reports model availability identities.
The extension styles only text and blocks present in the server draft
projection; removed live content stays in the dock's compare cards so old and
proposed prose can never compose into one manuscript line. Pure deletions use
empty positional anchors with a visible seam whose focused-operation state is
emphasized, so their cards can scroll the manuscript without adding text. An active preview
without a model is an invariant violation, logged loudly and ignored safely.

The server reviewable list emits only current-generation drafts with reviewable
content. `pendingReviewDrafts` is the shared client presentation seam that
filters rows without review content and orders the remaining drafts for the dock
and inline-review launcher. Branch lifecycle status is not review evidence: a
reusable manifest branch may remain active while carrying only bookkeeping.
Closed lifecycle rows, bookkeeping-only branches, and draft-level Undo receipts
are not part of this boundary.

See the
[requirements doc](https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/requirements.md)
for product decisions and the
[editable draft review authority decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-review-editable-branch.md)
for cross-cutting architecture.

The preview describes the branch-vs-live delta and supplies navigation evidence;
it does not scope Apply. Apply always settles the server's current branch.

## Draft review freshness

`DraftReviewProvider` owns the client cache freshness contract for mounted inline
reviews. When an inline review has a mounted draft `DocumentSession`, any Yjs
update in that draft room invalidates both:

- the active draft preview query, so the editor rail/hunks re-derive from the
  latest server review model; and
- the work draft list query, so the composer dock reflects updated draft counts
  without closing and reopening review.

This subscription is a freshness seam only. The TipTap/Yjs session remains the
single document-sync path; the provider never interprets update contents or builds
a second draft model.

Preview refresh remains presentation freshness. Apply does not send a
`draftRevisionToken` or operation set; the server branch is the command
authority.

## The pending signal and draft-only tab lifecycle

**One client pending projection; one server authority.**
`pendingReviewDrafts(group)` in `docked-drafts.ts` is the per-document client
"has changes to review" derivation. `pendingReviewDraft` selects its newest
draft, while `activeDockedDraftGroups` projects all pending groups once for
composer surfaces. The dock's pending rows, the identity bar's
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
`activeDockedDraftGroups` stays newest-updated-first for the DraftDock. The
composer's single **Review changes** action sorts a copy by
`documentName ?? documentId` and opens the alphabetically first pending
document; it must not reorder the shared projection.

**Draft-only tabs.** A NEW document proposed by a draft is real (documents
row + Yjs state) but absent from the live tree until accept. Its review tab
is synthesized by the launcher (`context-tab-from-draft.ts`) and marked
`draftOnly`, from the server's `isNewDocument` flag — derived per list
request from manifest membership (in the work manifest, not the live one),
never stored. Local disposition events and remote membership reconciliation
both route through
`resolveDraftOnlyTab(projectId, documentId, "committed" | "discarded")`:

- Every Apply path materializes the whole branch and resolves `"committed"` —
  keep the
  tab, drop the marker — after the awaited draft-list refresh but while the
  disposition lock remains held. Controls must not re-enable before that local
  resolution; draft-group absence alone cannot distinguish accept from discard.
- Whole-draft reject resolves `"discarded"` — close the tab.
- When a selected row disappears remotely from the active-only list, the
  provider forces a fresh live-manuscript manifest read. Membership means
  `"committed"`; absence means `"discarded"`. A failed read leaves the tab
  intact, and a replacement active draft for that document cancels resolution.
- A live-tree `openTab` refresh clears a stale marker. `saveLastContextRoute`
  skips draftOnly tabs so a discarded path can't replay on the next visit;
  `ContextPaneController` repairs the route when a lifecycle resolve removes
  the route-active tab.

Server-side twin: rejecting a new-document draft also removes its entry from
the work manifest branch — otherwise the next accept in that work pushes the
dead entry to live and the discarded document resurrects as an empty file
(caught by a runtime probe; regression test in
`collab-domain.reverse-turn.db.test.ts`).
