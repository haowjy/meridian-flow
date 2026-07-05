# features/chat — Turn render surface + transcript viewport

The chat frontend: how assistant turns render from `Block[]` onto the screen,
including the `Thinking`/`ActivityBlock` composition model, tool rendering,
interrupt interaction, and the live→settled transition — AND how the
conversation transcript scrolls (the explicit `follow | free` policy).

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
| `TurnEditsCard.tsx` | Inert per-turn record of what a turn EDITED (live + draft lineage docs, created files included): a default-collapsed card whose header carries only the document count, expanding to the per-document list. Folds the whole-turn Undo/Redo chip for any lineage row; the server routes per document to live, draft, or draft-accept undo. INVARIANT: record, not control panel — no Review/Apply/Discard here. |
| `block-render-key.ts` | Positional render keys |
| `block-kind.ts` | Type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `DraftDock.tsx` | Composer-attached strip: the SINGLE actionable surface for the Work's pending AI changes. `useDraftDock({ generating })` builds the model (generating / settled single+multi / expanded checklist / guided progression / all-reviewed fade-out / per-row cannot_place) and owns the sequential Apply-all/Discard-all pump; `<DraftDock>` renders it. Chrome, not a card — shares the composer's border box. |
| `docked-drafts.ts` | Pure dock assembly: `dockRows` (per-document pending/reviewed rows, pending first) + `activeDockedDraftGroups` (dock exists iff non-empty). |
| `draft-stats.tsx` | The single magnitude formatter: `+X −Y words` when word deltas land (feature-detected forward-compat fields), else `N edits`, else nothing. |
| `useAiDraftLauncher.ts` | Shared `openAiDraft(group, draftId)` used by the composer `DraftDock` strip and the dock `Changes` rows. Captures the pre-review rail state at module scope (the launcher's owner unmounts across navigation, so a `useRef` snapshot doesn't survive), navigates to `?screen=context&scheme=manuscript&path=/<doc>`, collapses `rail-l`, switches the dock to `Changes`, calls `enterInlineReview`. On exit, the effect restores whatever rail state we found. |
| `DraftReviewProvider.tsx` | Project-shell context plumbing: exposes the draft review session controller (carrying the focused threadId for thread-cache invalidation), work draft groups, and editor-host presence |
| `useDraftReviewController.ts` | One client review-session owner: inline review selection, stale/overlap/cannot-place states, whole-draft commands, and dock-card focus into the editor |
| `draft-review-controller-transitions.ts` | Pure review-session reducer for inline surface, whole-draft overlap/stale states, and terminal whole-draft cannot-place |
| `ComponentCard.tsx` | Shared token-driven shell for component blocks; three states: pending, resolved, reversible |
| `is-draft-undoable.ts` | Shared expiry rule for applied/discarded draft undo affordances |

## Draft review lifecycle

Inline review is the only draft review surface and applies the whole-draft `acceptDraft` path.
The controller is the single client review-session owner. Its reducer owns
`surface: none | inline`, the active `{ documentId, draftId }`, the whole-draft
overlap confirmation payload, stale-draft message target, and terminal whole-draft
cannot-place state. Use controller transitions instead of pairing local `close` calls;
`exitReview` is the single clear-all path.

On success, `applySucceeded` clears the active surface so the editor rebinds from
the draft room back to the live manuscript room. If accept returns
`status: "overlap"`, inline review keeps the draft active and stores the returned
`liveRevisionToken`; the next Apply confirms with `confirmedLiveRevisionToken`. Whole-draft discard uses the same
cleanup path.

Review mode is a full-width editor plus the dock's `Changes` view — there is no
in-editor proposal split. The editor's review chrome is
`features/editor/DraftReviewHeader` (below the toolbar, review-only): LEFT
"Back to live" exit, RIGHT whole-draft "Apply all" / "Discard all", all
delegating to the controller. The dock's `DockChangesView` expands the reviewed
document to flat per-operation rows read from the live preview; a row click calls
`controller.focusReviewOperation(operationId)`, which reads the review editor off
the inline-review runtime and highlights + scrolls the manuscript span.

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
→ [Terminal `cannot_place` UX KB decision](../../../../../../.meridian/git/haowjy-meridian-flow-docs/kb/decisions/terminal-cannot-place-ux.md)
