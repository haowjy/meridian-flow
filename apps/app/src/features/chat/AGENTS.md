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

- **Process disclosure** (collapsed) — all reasoning, all completed activity
  runs, and (once the durable turn settles) every frontier tool operation.
  Its visible label becomes a deterministic digest when it contains tools.
- **`ActivityBlock`** (visible) — the live last activity run. After settlement,
  only that frontier's non-tool blocks remain visible.

The partition keys off block order/type and the durable terminal-status
predicate. It never reads transient stream state (`isLive`, partial blocks).
At the durable status flip, tool rows move into the fold; the resulting final
frame is identical to a reload.

When a new activity run begins, the previous frontier **rolls up** into the
process fold in chronological position. Interrupts end a segment; their cards
remain visible after resolution even though tool protocol rows fold on settle.

The full model lives in
[`.context/turn-composition.md`](.context/turn-composition.md); draft receipts,
composer mode, and review state live in
[`.context/turn-edit-receipts.md`](.context/turn-edit-receipts.md),
[`.context/composer-write-mode.md`](.context/composer-write-mode.md), and
[`.context/draft-review.md`](.context/draft-review.md).

## Key rules

1. **Default-collapsed everywhere.** `Thinking` disclosures are closed by default
   whether streaming live or settled. No auto-open on streaming.
2. **Durable settlement folds tool rows.** `complete`, `cancelled`, and `error`
   put every segment's tool operations inside its fold. Live statuses keep the
   last activity run visible. Never key this decision off `isLive` or partial
   block content; use the contracts terminal-status predicate.
3. **Interrupt cards stay visible.** Resolution starts a new segment. On settle,
   tool protocol rows in every segment fold, while resolved interrupt cards and
   other frontier non-tool blocks remain expanded.
4. **Block render keys are positional.** Use `blockRenderKey(block)` —
   `turnId::sequence`. Never key by `block.id`. Blocks keep identity while they
   remain in one zone; frontier prose, images, and custom cards therefore do not
   remount at settlement. Tool views structurally move from the frontier into the
   process fold at settlement and may remount at that boundary.

## Anti-patterns

- **Don't branch on transient streaming state in partition logic.** Durable
  terminal status is an input; `isLive`, partial-block shape, and component-local
  stream state are not.
- **Don't key by `block.id`.** ID spaces can drift between sources; positional
  identity cannot. Use `blockRenderKey`.
- **Don't duplicate tool rendering between fold and activity zone.**
  `DeliverySegments` normalizes tool protocol blocks into ToolViews for both folded
  activity runs and visible frontiers. No raw tool block should reach `TurnBlockStep`.
- **Don't auto-open process disclosures during streaming.**

## Entry points

| File | What it does |
|---|---|
| `AssistantTurn.tsx` | Top-level turn render — sorts blocks, partitions, mounts zones |
| `partition-turn-segments.ts` | Structural interrupt segmentation + run grouping for Thinking/Activity zones |
| `group-delivery-segments.ts` | Pairs adjacent tool protocol blocks into ToolViews, then groups adjacent logical tool runs |
| `ProcessDisclosure.tsx` | Collapsible `Thinking` disclosure with sticky user-toggle |
| `CustomBlockRenderer.tsx` | Renders `custom` blocks; interrupts route through `onRespondToInterrupt` |
| `placeholders.ts` | Lingui `msg` descriptor pools + per-page-load localStorage rotation + `useSyncExternalStore` SSR guard. Rotation is internal to Composer; hero variant overrides by prop |
| `tool-renderers.tsx` | Tool renderer registry plus the shared `DocumentName` presentation used by tool rows and receipts |
| `AssistantTurn.tsx` (`DeliverySegments`) | Renders adjacent tool runs as sibling `ToolRow`s |
| `ActivityRow.tsx` | Timeline-row primitive; each row owns its rail segment and exports the shared text inset |
| `TurnBlockStep.tsx` | Compact label/body row for reasoning/prose/image fallback blocks; tools are handled upstream |
| `TurnEditsReceipt.tsx` | Quiet per-turn committed-edit receipt: durable titles/word totals, lineage-backed Undo/Redo, and authorized detail loading. No draft Review/Apply/Discard. |
| `ChangeViewRows.tsx` | Read-only receipt rows with exact navigation and clamped durable Before/After excerpts. |
| `conversation-reveal.ts` | One-shot editor→thread handshake: route to the owning thread, scroll its turn, expand Changes, and bring the exact row into view. |
| `block-render-key.ts` | Positional render keys |
| `block-kind.ts` | Type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `DraftDock.tsx` | Composer-attached strip for the Work's pending AI changes. `useDraftDock` assembles the model and starts bulk commands; `draft-review-session.ts` owns sequential execution and stop policy. `<DraftDock>` renders the chrome, not a card |
| `ComposerWriteModeControl.tsx` | Draft / Auto-apply selector bound to the exact Work resolved at the project/chat composition root |
| `docked-drafts.ts` | Pure active-draft assembly: `dockRows` (one pending row per document), `hasDockChanges` (Changes-tab visibility), and `activeDockedDraftGroups` (composer DraftDock visibility). |
| `draft-stats.tsx` | The single magnitude formatter: `+X −Y words` when word deltas land (feature-detected forward-compat fields), else `N edits`, else nothing. |
| `useAiDraftLauncher.ts` | Shared `openAiDraft(group, draftId)` review entry for the dock strip and `Changes` rows: navigates to the manuscript, collapses rails, enters inline review; restores rail state on exit (capture mechanics explained in its header comment) |
| `DraftReviewProvider.tsx` | Project-shell context plumbing: exposes the draft review session controller (carrying the focused threadId for thread-cache invalidation), work draft groups, and editor-host presence |
| `useDraftReviewController.ts` | One client review-session owner: selection, stale-draft state, whole-draft + per-card commands, and the `isDisposing` lock serializing every disposition. Emits message codes (no writer-facing strings); the dock localizes |
| `draft-review-session.ts` | Shared disposition lock, revision acquisition, response policy, command sequencing, and review-session reducer |
| `ComponentCard.tsx` | Shared token-driven shell for component blocks; three states: pending, resolved, reversible |

## Draft-review boundary

Inline review is the only draft-review surface. It uses server-backed
Apply/Discard disposition commands; the read-only review editor never
uses browser mutation history. See
[`.context/draft-review.md`](.context/draft-review.md) for the lifecycle, session,
preview, and projection contracts.

## Block type reference

From `@meridian/contracts` `BlockType`: `reasoning` | `thinking` | `text` |
`tool_use` | `tool_result` | `image` | `custom`.

- **reasoning run** = `reasoning` | `thinking` (rendered in `TurnBlockStep`, italic prose)
- **activity run** = everything else (text/image/custom rendered directly; tool_use/tool_result
  normalized into ToolViews and rendered as sibling `ToolRow`s by
  `DeliverySegments`)

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
→ [KB: chat scroll follow-state decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat-scroll-follow-state.md)

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [Requirements: Undo & Draft Review UX](https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/requirements.md)
→ [Draft review projection authority decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-review-projection-authority.md)
→ [QA runtime probes for draft review](../../../../../docs/qa/draft-review.md) — run when changing disposition state, the dock, or the review launcher
