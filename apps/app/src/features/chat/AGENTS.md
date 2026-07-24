# features/chat — Turn render surface + transcript viewport

The chat frontend: assistant-turn rendering, transcript scrolling, and the
conversation-attached composer chrome, including Work-scoped draft controls.

## Purpose

This directory owns the **assistant turn render surface** — the components and
partition logic that convert an ordered `Block[]` (from `@meridian/contracts` `Turn`)
into what the reader sees — and the **transcript viewport** (`TurnList.tsx`), the
single scroll container for the conversation. It is NOT the chat session, thread
management, or composer — those are adjacent concerns in sibling files
(`useChatThreadSession`, `Composer.tsx`).

## Mental model

An assistant turn renders as a **stack of segments**, one per interrupt round.
Each segment has exactly two zones:

- **`Thinking` disclosure** (collapsed) — process history: all reasoning blocks
  + all completed (non-latest) activity runs, in chronological order.
- **`ActivityBlock`** (visible) — the **last activity run** — the delivery
  frontier the reader is focused on.

The partition is **purely structural**: it depends only on block order and block
type, never on streaming state. This guarantees a settled/reloaded turn renders
the same structure the user saw live.

When a new activity run begins, the previous frontier **rolls up** into `Thinking`
in its chronological position. When a interrupt is resolved, the segment is
**frozen** and a new segment begins below.

The full model — including the 6-state lifecycle table and interrupt segmentation
diagrams — lives in [`.context/CONTEXT.md`](.context/CONTEXT.md).

## Key rules

1. **Default-collapsed everywhere.** `Thinking` disclosures are closed by default
   whether streaming live or settled. No auto-open on streaming.
2. **Streaming ≡ settled.** The partition logic must never branch on `isLive` or
   `turn.status`. Same `Block[]` order → same render structure.
3. **Interrupt segments are frozen.** Once a user responds to a interrupt, that
   segment's `ActivityBlock` (including the interrupt) stays expanded forever —
   never rolled up into a later segment's `Thinking`.
4. **Block render keys are positional.** Use `blockRenderKey(block)` —
   `turnId::sequence`. Never key by `block.id`. This ensures the live→settled swap
   is an in-place content replace, not a remount.

## Anti-patterns

- **Don't branch on streaming state in partition logic.** If `isLive` appears in
  `partitionTurnSegments` or determines which zone a block lands in, you're
  building a settled-reload divergence.
- **Don't key by `block.id`.** ID spaces can drift between sources; positional
  identity cannot. Use `blockRenderKey`.
- **Don't duplicate tool rendering between fold and activity zone.**
  `DeliverySegments` normalizes tool protocol blocks into ToolViews for both folded
  activity runs and visible frontiers. No raw tool block should reach `TurnBlockStep`.
- **Don't hard-code `defaultOpen={reasoningStreaming}`.** That's the old model
  being migrated away from.

## Entry points

| File | What it does |
|---|---|
| `AssistantTurn.tsx` | Top-level turn render — sorts blocks, partitions, mounts zones |
| `partition-turn-segments.ts` | Structural interrupt segmentation + run grouping for Thinking/Activity zones |
| `group-delivery-segments.ts` | Pairs adjacent tool protocol blocks into ToolViews, then groups adjacent logical tool runs |
| `ProcessDisclosure.tsx` | Collapsible `Thinking` disclosure with sticky user-toggle |
| `CustomBlockRenderer.tsx` | Renders `custom` blocks; interrupts route through `onRespondToInterrupt` |
| `tool-renderers.tsx` | Tool renderer registry — maps tool names to icon/title/expand behavior |
| `ToolRunBlock.tsx` | Collapsed disclosure for adjacent ToolView runs |
| `TurnBlockStep.tsx` | Compact label/body row for reasoning/prose/image fallback blocks; tools are handled upstream |
| `TurnEditsCard.tsx` | Existing per-turn Changes view: lineage-backed Undo plus durable trail detail rows and recovery actions. No draft Review/Apply/Discard. Full model in [`.context/draft-editing.md`](.context/draft-editing.md). |
| `ThreadChangesCard.tsx` | Quiet transcript-tail Changes record for shared trails with no owning turn. It reuses protected rows and recovery actions without inventing turn ownership. |
| `ChangeViewRows.tsx` | Captured-body sweep/resurrection rows with navigation and idempotent Restore/Delete again action seams |
| `conversation-reveal.ts` | One-shot editor→thread handshake: route to the owning thread, scroll its turn, expand Changes, emphasize the exact row |
| `block-render-key.ts` | Positional render keys |
| `block-kind.ts` | Type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `DraftDock.tsx` | Composer-attached strip: the SINGLE actionable surface for the Work's pending AI changes. `useDraftDock` owns the model + the sequential Apply-all/Discard-all pump; `<DraftDock>` renders it. Chrome, not a card |
| `DraftModeIndicator.tsx` | Quiet, informational thread-header strip shown only while the server-authoritative Work is in Draft mode. It is not a control. |
| `ComposerWriteModeControl.tsx` | Compact Draft / Auto-apply selector beside the Writer pill. `ProjectView` resolves the thread's Work once for the provider and `ChatView`; the control reads and mutates only that Work, with server-authoritative confirmation before pushing pending drafts live. |
| `docked-drafts.ts` | Pure dock assembly: `dockRows` (per-document pending/reviewed rows, pending first) + `activeDockedDraftGroups` (dock exists iff non-empty). |
| `draft-stats.tsx` | The single magnitude formatter: `+X −Y words` when word deltas land (feature-detected forward-compat fields), else `N edits`, else nothing. |
| `useAiDraftLauncher.ts` | Shared `openAiDraft(group, draftId)` review entry for the dock strip and `Changes` rows: navigates to the manuscript, collapses rails, enters inline review; restores rail state on exit (capture mechanics explained in its header comment) |
| `DraftReviewProvider.tsx` | Project-shell context plumbing: exposes the draft review session controller (carrying the focused threadId for thread-cache invalidation), work draft groups, and editor-host presence |
| `useDraftReviewController.ts` | One client review-session owner: selection, stale-draft state, whole-draft + per-card commands, and the `isDisposing` lock serializing every disposition. Emits message codes (no writer-facing strings); the dock localizes |
| `draft-review-controller-transitions.ts` | Pure review-session reducer for inline surface, stale-draft handling, closure/discard confirmations, inline messages, and per-draft discard pending state |
| `ComponentCard.tsx` | Shared token-driven shell for component blocks; three states: pending, resolved, reversible |
| `@/client/query/draft-undoable.ts` | Shared expiry rule for applied/discarded draft undo affordances |

## Draft review lifecycle

Inline review is the only draft review surface. Whole-draft "Apply all" runs the
`acceptDraft` path; each dock Changes card also carries per-card Apply/Discard,
and a per-card Apply's "Change applied" receipt carries an Undo.
The controller is the single client review-session owner. Its reducer owns
`surface: none | inline`, the active `{ documentId, draftId }`, stale-draft
message target, inline messages, and per-draft discard pending state. Use
controller transitions instead of pairing local `close` calls; `exitReview` is
the single clear-all path.

Per-card Apply routes the closure-card `acceptDraft` mutation with
`operationIds`; the server receives the vended closure class as one card, so
there is no dependency confirmation state. Every disposition is serialized by
one lock (`controller.isDisposing` / `acceptIsBlocked`): while any whole-draft or
per-card Apply/Discard/Undo is in flight, all mutating controls disable and a
second card click is ignored rather than clearing the in-flight card's pending
state. Per-card Discard routes to the server discard mutation with
`operationIds`; the server performs reversal-peer sync and the card settles when
the next preview refetch drops the operation. Keep that pending state and timer
in the controller/session path, keyed by draft id; do not add module-global or
component-local review/discard state.

On success, `applySucceeded` clears the active surface so the editor rebinds from
the draft room back to the live manuscript room. If accept returns
`status: "stale_draft"`, inline review reloads the refreshed draft id from the
response. Whole-draft discard uses the same cleanup path.

Review mode is a full-width editor plus the dock's `Changes` view — there is no
in-editor review split. The editor's review chrome is
`features/editor/DraftReviewHeader` (below the toolbar, review-only): LEFT
"Back to live" exit, RIGHT whole-draft "Apply all" / "Discard all", all
delegating to the controller. The dock's `DockChangesView` expands the reviewed
document to operation cards read from the live preview; a card body click calls
`controller.focusReviewOperation(operationId)`, which reads the review editor off
the inline-review runtime and highlights + scrolls the manuscript span. Each card
carries hover-revealed Apply/Discard verbs — the only mutating targets on the
card — driving `controller.acceptOperation` / `controller.discardOperation`.

`useInlineReviewSync` is a plugin adapter only: it pushes server hunk models into
the TipTap inline-review extension and reports model availability identities. An
active preview without a model is an invariant violation, logged loudly and
ignored safely.

`reviewableDraftsForGroup` is the presentation seam for draft lifecycle rows. It
keeps active drafts visible and hides older terminal undo receipts when a newer
active draft exists in the same document group; the server reviewable list still
contains the full lifecycle history so the `DraftDock` reviewed rows and the
editor bar's minimal terminal Undo receipt can show undo where it remains useful.

## Block type reference

From `@meridian/contracts` `BlockType`: `reasoning` | `thinking` | `text` |
`tool_use` | `tool_result` | `image` | `custom`.

- **reasoning run** = `reasoning` | `thinking` (rendered in `TurnBlockStep`, italic prose)
- **activity run** = everything else (text/image/custom rendered directly; tool_use/tool_result
  normalized into ToolViews and rendered as `ToolCard` or `ToolRunBlock`)

## Transcript viewport (TurnList)

`TurnList.tsx` is the **single scroll owner** for the conversation. There is no
second scroll engine and no nested scroller — the viewport is one plain
`overflow-y:auto` div with `[overflow-anchor:none]` so browser scroll anchoring
doesn't compete with TanStack Virtual's own compensation.

TanStack Virtual owns **geometry** (row layout, measured heights, above-viewport
size-change compensation). `useChatFollowScroll` owns **policy** — the explicit
`follow | free` state machine. Geometry never doubles as policy state; deriving
"at bottom" per-frame from offsets is what made the pill flicker and
follow-release feel inconsistent.

Key contract: **no child component may own a scroller**. Assistant turn
rendering (`AssistantTurn.tsx`, `ProcessDisclosure.tsx`) owns only the
disclosure expand/collapse — the viewport is TurnList's invariant.

→ TurnList.tsx header comment (single-scroll-owner contract + geometry/policy split)
→ useChatFollowScroll.ts header comment (state machine invariants +
  re-armable 180ms guard + near-bottom-wins ordering)
→ [KB: chat scroll follow-state decision](../../../../../../.meridian/git/haowjy-meridian-flow-docs/kb/decisions/chat-scroll-follow-state.md)

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [Requirements: Undo & Draft Review UX](../../../../../../.meridian/git/haowjy-meridian-flow-docs/work/human-undo-affordance/requirements.md)
→ [Draft Review Lifecycle KB decision](../../../../../../.meridian/git/haowjy-meridian-flow-docs/kb/decisions/draft-review-lifecycle.md)
→ [QA runtime probes for draft review](../../../../../docs/qa/draft-review.md) — run when changing disposition state, the dock, or the review launcher
