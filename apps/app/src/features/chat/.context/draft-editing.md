# Draft editing — receipts, write mode, and review lifecycle

This page defines the chat contracts for turn edit receipts, Work-scoped write
mode, and draft-review state. Turn rendering is documented separately in
[turn composition](turn-composition.md).

## Turn edits card (`TurnEditsCard.tsx`)

The per-turn Changes view is a default-collapsed record for committed document
edits. Its header names one document or counts several and adds settled
`+added −removed words` totals when the trail shell has them. Live
single-document headers derive the same URI title without inventing a delta.
The shell carries header metadata, so collapse never triggers a detail fetch.
Expanding shows live documents and authorized durable trail rows.

`AssistantTurn` combines server-owned facts: full turn lineage supplies document
scope, the durable receipt supplies whole-turn Undo/Redo authority, and the
settled trail supplies historical titles, word totals, and protected change
rows. Both direct and draft lineage may produce the same card. A draft proposal
with neither live lineage nor settled trail documents produces no card; after
Apply, the committed receipt remains visible across reload.

The single Undo/Redo action calls the turn-scoped reverse endpoint. Receipt state
(`live-active`, `branch-active`, reversed, dependent, or expired) decides whether
it is available. Unavailable actions render an explicit `Can't undo` notice and
server-derived reason; the client does not invent local receipt state. Sweep and
resurrection rows retain only forward human actions (`Restore` / `Delete again`),
idempotent by `changeId`. Captured bodies remain visible after document loss and
reload, and deleted live anchors degrade navigation without discarding evidence.

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

`ComposerWriteModeControl` owns the mutation and uses the dock-derived pending
count only to open confirmation quickly. Every Auto-apply selection sends an
unconfirmed request; the server-vended journal-row count is the number shown in
the confirmation, and only its explicit Apply button sends `confirmedPush`. Moving Draft → Auto-apply
with pending draft changes opens its confirmation popover; confirmation asks the server to push every pending Work
draft to the live manuscript and only then switch policy. A failed push leaves
Draft selected. The sidebar has no write-mode control.

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

### Change-trail row suppression

`ChangeViewRows` returns `null` when every change is a plain insert without
writer protection. `TurnEditsCard` remains visible because it carries the
document line and whole-turn Undo. Mixed trails and protected changes retain
the full row list; per-row filtering inside mixed trails remains outside this
contract.

## Draft review architecture

The composer-attached `DraftDock`, dock `Changes` view, and editor
`DraftReviewHeader` share one server-backed draft state through
`DraftReviewProvider`. Client review-session state has one owner:
`useDraftReviewController` plus `draft-review-controller-transitions.ts`.
Whole-draft and per-card Apply share revision acquisition and response policy
through `draft-apply-disposition.ts`; the controller only coordinates that
disposition with UI state and editor tabs.

That session owns active inline selection, stale-draft handling,
closure/discard confirmations, inline messages, discard timers, and the inline
discard journal cache. Editor-side code adapts runtime inputs:
`useInlineReviewSync` pushes and reports plugin models; dock cards focus and
settle changes through the controller.

See the
[requirements doc](https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/requirements.md)
for product decisions and the
[draft review lifecycle decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-review-lifecycle.md)
for cross-cutting architecture.

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
- Whole-draft reject resolves `"discarded"` — close the tab. The provider's
  disappearance effect also resolves `"discarded"` unconditionally: it is
  only ever reached for discard exhaustion, since accepts cleared the marker
  first (the server list never returns terminal drafts, so there is no
  terminal evidence to disambiguate with).
- `openTab`'s metadata merge deliberately never clears the marker (absent
  keys don't override); `saveLastContextRoute` skips draftOnly tabs so a
  discarded path can't replay on the next visit; `ContextPaneController`
  repairs the route when a lifecycle resolve removes the route-active tab.

Server-side twin: rejecting a new-document draft also removes its entry from
the work manifest branch — otherwise the next accept in that work pushes the
dead entry to live and the discarded document resurrects as an empty file
(caught by a runtime probe; regression test in
`collab-domain.reverse-turn.db.test.ts`).
