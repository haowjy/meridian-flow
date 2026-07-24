# Draft editing — receipts, write mode, and review lifecycle

This page defines the chat contracts for turn edit receipts, Work-scoped write
mode, and draft-review state. Turn rendering is documented separately in
[turn composition](turn-composition.md).

## Turn edits card (`TurnEditsCard.tsx`)

The existing per-turn Changes view below each assistant turn that edited
documents: a default-collapsed card
whose header carries the edit icon and chapter count — `✎ AI edited N chapter(s)` — expanding to
the per-document list and authorized durable change-trail rows. Trail detail is
writer-touching iff `writerProtection` is present: pure-generative changes render
no detail rows, and mixed turns show only their writer-touching changes. A
conversation reveal (`conversation-reveal.ts`, opened from an editor peer mark's
*Open conversation*) additionally surfaces the targeted change row even when it
is not writer-touching, so the jump can land on and emphasize the exact change;
outside that reveal the filter is unchanged. The
plain document line and whole-turn Undo remain regardless. Created files count like any edit (creation flows
through the same agent-edit write path and produces mutation rows). Rows come
from turn lineage in BOTH scopes (`live` + `draft` via `useTurnLiveLineage`),
while historical row evidence comes from the authorized trail reader. Undo is
guarded by the canonical receipt state. Sweep and resurrection rows carry only
forward human actions (`Restore` / `Delete again`), idempotent by `changeId`.
Captured bodies remain visible after document loss and reload; an unavailable
live root degrades to Copy. There is no ChangeTrail transcript
card or finishing presentation. INVARIANT: no draft Review/Apply/Discard here;
pending changes belong to the composer-attached `DraftDock`.

**Two-mode undo model.** The conversation has two distinct undo systems — same
Yjs reversal engine, different scope and interaction pattern:

| Mode | Per-turn receipt | Undo behavior |
|---|---|---|
| **Auto-apply** (`direct`) | ActivityRow with [Undo] button | Reverses the Yjs mutation; creates a synthetic transcript turn ("You undid changes to …") with Redo. The synthetic turn is client-local until the writer moves on. |
| **Draft mode** (`draft`) | 1-line informational receipt | Undo removes this turn's contribution from the accumulated draft. The actionable surface is the composer-attached `DraftDock`; the dock `Changes` view and the editor's `DraftReviewHeader` carry review. |

Turn edits line behavior in auto-apply mode:

- **Document list source** — `AssistantTurn` calls `useTurnLiveLineage(threadId,
  turnId)`, backed by `GET /api/threads/:threadId/turns/:turnId/live-lineage`.
  The server derives documents from live `agent_edit_mutations` filtered to
  `scope_id = 'live'`; tool blocks, `turn_document_touches`, and
  recent-documents are not undo authority.
- **Draft review separation** — draft-only turns have no live-lineage line. When
  a draft is applied, accept creates a distinct user accept turn and stamps the
  live mutation with that accept turn, so the record belongs to the writer
  acceptance event rather than the proposing assistant turn.
- **Whole-turn Undo/Redo** — the single `Undo` chip calls
  `POST /api/threads/:threadId/context/reverse` with
  `{ direction, scope: "turn", target: turnId }` (`reverseTurn` across every
  live-lineage document the turn touched); it flips to `Redo` after an undo.
  Per-document granularity from the old footer is intentionally dropped — the
  line is a record, not a control panel.
- **Local state** — the line tracks a single disposition locally
  (`applied` | `reversed` | `disabled`); `expired` disables the chip. Document
  content refresh after reversal is handled by Yjs sync.

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
the confirmation, and only its explicit Apply button sends `confirmedPush`. Moving Draft → Auto-apply
with pending draft changes opens its confirmation popover; confirmation asks the server to push every pending Work
draft to the live manuscript and only then switch policy. A failed push leaves
Draft selected. The sidebar has no write-mode control.

Home bootstrap is a distinct path: its optimistic thread has no Work while the
first message is handed off, and project plus default-Work creation occur
mid-handoff. That first turn therefore uses the new Work's `direct` default
before the composer can expose the mode control. In-project new threads already
have a Work and do not have this gap.

## Draft review architecture

The composer-attached `DraftDock`, dock `Changes` view, and editor
`DraftReviewHeader` share one server-backed draft state through
`DraftReviewProvider`. Client review-session policy has one owner:
`draft-review-session.ts`. It owns the synchronous disposition lock, typed
outcomes, revision acquisition, Apply response interpretation, and pure UI
transitions. `useDraftReviewController` adapts React Query and editor/tab ports
to those commands.

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
