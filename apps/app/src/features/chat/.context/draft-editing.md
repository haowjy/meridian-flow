# Draft editing — receipts, write mode, and review lifecycle

This page defines the chat contracts for turn edit receipts, Work-scoped write
mode, and draft-review state. Turn rendering is documented separately in
[turn composition](turn-composition.md).

## Turn edit receipt (`TurnEditsReceipt.tsx`)

The per-turn receipt is a quiet, default-collapsed record for committed
document edits. Its line names one document or counts several and adds settled
`+added −removed words` totals when the trail shell has them. Live
single-document headers derive the same URI title without inventing a delta.
The shell carries header metadata, so collapse never triggers a detail fetch.
Expanding shows live documents and every authorized durable trail row. Each row
renders its retained Before and/or After excerpt; Copy is available on Before.
A conversation reveal opened from an editor peer mark expands the receipt and
emphasizes its exact target row.

`AssistantTurn` combines server-owned facts: full turn lineage supplies document
scope, the durable receipt supplies whole-turn Undo/Redo authority, and the
settled trail supplies historical titles, word totals, and change rows. Both
direct and draft lineage may produce the same receipt. A draft proposal
with neither live lineage nor settled trail documents produces no card; after
Apply, the committed receipt remains visible across reload.

The single Undo/Redo action calls the turn-scoped reverse endpoint. Receipt state
(`live-active`, `branch-active`, reversed, dependent, or expired) decides whether
it is available. Unavailable actions render a compact `Can't undo` pill; the
server-derived reason appears only after expansion. Captured Before/After
excerpts remain visible after document loss and reload, and deleted live anchors
degrade navigation without discarding the receipt.

The card is a record, not a draft control panel. Draft Review/Apply/Discard
remain exclusively in the composer-attached `DraftDock` and inline review
surface.

## Composer write mode

The Draft / Auto-apply selector lives in the composer footer beside the agent
pill because write mode is a property of the conversation's Work, not workspace
navigation. `ProjectView` resolves the displayed thread’s Work once at the project
composition boundary and passes that same Work identity to `DraftReviewProvider`
and `ChatView`; the dock and composer control therefore share one binding. If
either side of `thread → work` is absent, the control is not rendered. The
independent chat composition root performs the same resolution for its thread.
There is no first/default-Work fallback.

When that server-authoritative Work is in Draft mode, `ChatView` also renders a
quiet informational strip in the thread header. It disappears in Auto-apply and
never mutates mode; the composer selector remains the only mode control.

`ComposerWriteModeControl` owns the mutation and uses the dock-derived pending
count only to open confirmation quickly. Every Auto-apply selection sends an
unconfirmed request; the server-vended journal-row count is the number shown in
the confirmation. Moving Draft → Auto-apply with pending changes keeps Draft
selected and opens the **Drafts are waiting** popover. Cancel preserves the
mode; Review changes uses the same `useAiDraftLauncher` entry as every other
review control; Apply all and switch is the only action that sends
`confirmedPush`. It asks the server to push every pending Work draft to the live
manuscript and only then switch policy. A failed push leaves Draft selected.
The Auto-apply choice is never disabled, and the sidebar has no write-mode
control.

Home bootstrap is a distinct path: its optimistic thread has no Work while the
first message is handed off, and project plus default-Work creation occur
mid-handoff. That first turn therefore uses the new Work's `direct` default
before the composer can expose the mode control. In-project new threads already
have a Work and do not have this gap.

Each assistant turn durably records the Work write mode read when that turn is
created. Tool vocabulary and receipt interpretation use the turn's recorded
mode, not the Work's current mutable policy, so a later mode switch cannot
rewrite history after reload.

### Composer placeholder and sizing contracts

`placeholders.ts` owns the per-page-load compose and interject prompt pools as
Lingui `msg` descriptors. `selectPagePlaceholders()` advances localStorage once
per page load and freezes that selection; component re-renders do not consume
another entry. `useSyncExternalStore` supplies a stable first descriptor during
SSR and the rotated descriptor on the client, while locale resolution happens
inside the hook. Composer owns rotation; its `placeholder` prop remains the
explicit override used by the Home hero.

The base `Textarea` applies `field-sizing-content`, but Composer's JavaScript
resize loop requires `field-sizing: fixed`. Keep that override inline:
Tailwind merge does not reliably deduplicate `field-sizing-*` utilities.

### Change-trail rows

`TurnEditsReceipt` renders every authorized trail change in ordinal order. The
one-shot *Open conversation* reveal only expands the receipt and emphasizes the
target row; it does not change which rows are mounted.

## Draft review architecture

Inline review is the only draft review surface. Whole-draft "Apply all" runs the
`acceptDraft` path; each dock Changes card also carries per-card Apply/Discard,
and a per-card Apply's "Change applied" receipt carries an Undo.
The controller is the single client review-session owner. Its reducer owns
`surface: none | inline`, the active `{ documentId, draftId }`, stale-draft
message target, and inline messages. The synchronous disposition lock is the
only pending-command source. Use controller transitions instead of pairing
local `close` calls; `exitReview` is the single clear-all path.
`DraftReviewProvider` keys that owner by Project + Work so review and dock-error
state cannot cross a Work switch.

Per-card Apply routes the closure-card `acceptDraft` mutation with
`operationIds`; the server receives the vended closure class as one card, so
there is no dependency confirmation state. Every disposition is serialized by
the session's synchronous lock (`controller.isDisposing`): while any whole-draft or
per-card Apply/Discard/Undo is in flight, all mutating controls disable and a
second card click is ignored rather than clearing the in-flight card's pending
state. Per-card Discard routes to the server discard mutation with
`operationIds`; the server performs reversal-peer sync. The mutation awaits the
draft-list and preview refreshes before the session releases its lock, so no
second preview-settlement timer or local pending copy is needed.

Bulk Apply/Discard is one controller command over a captured target list; the
dock does not infer command completion from busy/idle render edges. Direct
inline Apply uses the exact preview the writer reviewed; bulk Apply acquires
each captured draft's current preview while retaining the batch reservation.
A reviewed whole-draft Apply stays disabled until that exact preview is
available; Apply/Discard failures are session outcomes rendered by the review
header rather than ignored promises.
A batch stops at its first failure; transport failures surface through the
dock's typed error state. Apply always merges through Yjs, including when the
writer changed the same passage after the draft was cut. The durable receipt
records every edit without classification; best-effort provenance only elevates
a swept mark in the connected session.

On whole-draft Apply or Discard, the controller selects the nearest remaining
active row for the same document (same index, otherwise the previous row) when
one exists. Review stays open and swaps its selection without restoring the
rails. The last row clears the surface so the editor rebinds from the draft room
to the live manuscript room. If accept returns `status: "stale_draft"`, inline
review reloads the refreshed draft id from the response. Review never
automatically hops to another document.

The multi-row transition is a defensive client contract, not a state the
current production server can create. The server owns one active Work-draft
branch per `(documentId, workId)` and aggregates every contributing thread into
that branch, so its review list contains at most one active row for a document.
The same-document stepper and its synthetic tests remain unreachable until the
review-identity architecture changes.

Review mode is a full-width editor plus the dock's `Changes` view — there is no
in-editor review split. The editor's review chrome is
`features/editor/DraftReviewHeader` (above the identity bar, review-only): LEFT
"Back to live" exit, an oldest-first same-document stepper when the client is
given more than one active row, and RIGHT whole-draft "Apply all" / "Discard
all", all delegating to the controller. The stepper swaps the selected
`draftId`; it does not exit and re-enter review. Under the current one-Work-draft
server invariant it does not render in production. The dock's `DockChangesView`
expands the reviewed document to operation cards read from the live preview; a
card body click calls
`controller.focusReviewOperation(operationId)`, which reads the review editor off
the inline-review runtime and highlights + scrolls the manuscript span. Each card
carries hover-revealed Apply/Discard verbs — the only mutating targets on the
card — driving `controller.acceptOperation` / `controller.discardOperation`.

The review editor is read-only. Draft content changes only through agent writes
and explicit Apply/Discard commands; ordinary TipTap input is disabled and the
server rejects client-authored branch-room updates. Any writer-facing Undo is a
server-backed disposition command, never browser Ctrl+Z or a client mutation
origin.

`useInlineReviewSync` is a plugin adapter only: it pushes server hunk models into
the TipTap inline-review extension and reports model availability identities.
The extension styles only text and blocks present in the server draft
projection; removed live content stays in the dock's compare cards so old and
proposed prose can never compose into one manuscript line. Pure deletions use
empty positional anchors with a visible seam whose focused-operation state is
emphasized, so their cards can scroll the manuscript without adding text. An active preview
without a model is an invariant violation, logged loudly and ignored safely.

`reviewableDraftsForGroup` is the presentation seam for draft lifecycle rows. It
keeps active drafts visible and hides older terminal undo receipts when a newer
active draft exists in the same document group; the server reviewable list still
contains the full lifecycle history so the `DraftDock` reviewed rows and the
editor bar's minimal terminal Undo receipt can show undo where it remains useful.

See the
[requirements doc](https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/requirements.md)
for product decisions and the
[draft review projection authority decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-review-projection-authority.md)
for cross-cutting architecture.

The server preview identity (`draftId` plus live and draft revision tokens)
controls whether the displayed Apply request is current.

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

Accept paths gate on a fresh `draftRevisionToken` taken from the preview fetch,
never from client Yjs sync state — the server token is the authority on what the
writer actually reviewed.

## The pending signal and draft-only tab lifecycle

**One pending signal.** `pendingReviewDraft(group, nowMs)` in
`docked-drafts.ts` is THE per-document "has changes to review" derivation
(newest active draft that carries review content). The dock's pending rows,
the identity bar's `DraftReviewChip` (self-contained; hides itself during
that document's inline review so it never coexists with
`DraftReviewHeader`), and the Draft→Auto-apply switch count
(`pendingDockedDraftCount`) all derive from it. Never grow a second
is-pending derivation; surfaces that disagree about pending state was a
shipped bug class (dock said none, mode-switch dialog said one).

**Draft-only tabs.** A NEW document proposed by a draft is real (documents
row + Yjs state) but absent from the live tree until accept. Its review tab
is synthesized by the launcher (`context-tab-from-draft.ts`) and marked
`draftOnly`, from the server's `isNewDocument` flag — derived per list
request from manifest membership (in the work manifest, not the live one),
never stored. The marker's lifecycle is event-based via
`resolveDraftOnlyTab(projectId, documentId, "committed" | "discarded")`:

- Every accept path (whole-draft AND per-card, which materializes a new
  document on the first partial apply) resolves `"committed"` — keep the
  tab, drop the marker — and must do so BEFORE the workDrafts refetch lands,
  because draft-group absence alone cannot distinguish accept from discard.
- Whole-draft reject resolves `"discarded"` — close the tab.
- A remotely closed selected row resolves the tab only when the refreshed list
  carries truthful terminal evidence: `appliedAt` means `"committed"` and
  `discardedAt` means `"discarded"`. If another active same-document row
  remains, review advances to it after resolving any committed tab state.
  The current server normally returns active rows only, so disappearance
  without terminal evidence must exit safely without closing or graduating a
  draft-only tab.
- `openTab`'s metadata merge deliberately never clears the marker (absent
  keys don't override); `saveLastContextRoute` skips draftOnly tabs so a
  discarded path can't replay on the next visit; `ContextPaneController`
  repairs the route when a lifecycle resolve removes the route-active tab.

Server-side twin: rejecting a new-document draft also removes its entry from
the work manifest branch — otherwise the next accept in that work pushes the
dead entry to live and the discarded document resurrects as an empty file
(caught by a runtime probe; regression test in
`collab-domain.reverse-turn.db.test.ts`).
