# features/chat — Assistant turn rendering surface

The chat frontend: how assistant turns render from `Block[]` onto the screen,
including the `Thinking`/`ActivityBlock` composition model, tool rendering,
checkpoint interaction, and the live→settled transition.

## Purpose

This directory owns the **assistant turn render surface** — the components and
partition logic that convert an ordered `Block[]` (from `@meridian/contracts` `Turn`)
into what the reader sees. It is NOT the chat session, thread management, or
composer — those are adjacent concerns in sibling files (`useChatThreadSession`,
`Composer.tsx`).

## Mental model

An assistant turn renders as a **stack of segments**, one per checkpoint round.
Each segment has exactly two zones:

- **`Thinking` disclosure** (collapsed) — process history: all reasoning blocks
  + all completed (non-latest) activity runs, in chronological order.
- **`ActivityBlock`** (visible) — the **last activity run** — the delivery
  frontier the reader is focused on.

The partition is **purely structural**: it depends only on block order and block
type, never on streaming state. This guarantees a settled/reloaded turn renders
the same structure the user saw live.

When a new activity run begins, the previous frontier **rolls up** into `Thinking`
in its chronological position. When a checkpoint is resolved, the segment is
**frozen** and a new segment begins below.

The full model — including the 6-state lifecycle table and checkpoint segmentation
diagrams — lives in [`.context/CONTEXT.md`](.context/CONTEXT.md).

## Key rules

1. **Default-collapsed everywhere.** `Thinking` disclosures are closed by default
   whether streaming live or settled. No auto-open on streaming.
2. **Streaming ≡ settled.** The partition logic must never branch on `isLive` or
   `turn.status`. Same `Block[]` order → same render structure.
3. **Checkpoint segments are frozen.** Once a user responds to a checkpoint, that
   segment's `ActivityBlock` (including the checkpoint) stays expanded forever —
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
| `partition-turn-segments.ts` | Structural checkpoint segmentation + run grouping for Thinking/Activity zones |
| `group-delivery-segments.ts` | Pairs adjacent tool protocol blocks into ToolViews, then groups adjacent logical tool runs |
| `ProcessDisclosure.tsx` | Collapsible `Thinking` disclosure with sticky user-toggle |
| `CustomBlockRenderer.tsx` | Renders `custom` blocks; checkpoints route through `onRespondToCheckpoint` |
| `tool-renderers.tsx` | Tool renderer registry — maps tool names to icon/title/expand behavior |
| `ToolRunBlock.tsx` | Collapsed disclosure for adjacent ToolView runs |
| `TurnBlockStep.tsx` | Compact label/body row for reasoning/prose/image fallback blocks; tools are handled upstream |
| `block-render-key.ts` | Positional render keys |
| `block-kind.ts` | Type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `DraftReviewCard.tsx` | Chat-anchored review card for AI drafts; delegates preview to `onReview` |
| `DraftPreviewOverlay.tsx` | Modal prose-diff/clean-preview surface; **owned by `ChatView`, not by the card** |
| `diff-lines.ts` | LCS line-level diff for the preview overlay (prose, not code) |
| `anchor-drafts.ts` | Splits draft groups by producing assistant turn `lastActorTurnId` |

## Block type reference

From `@meridian/contracts` `BlockType`: `reasoning` | `thinking` | `text` |
`tool_use` | `tool_result` | `image` | `custom`.

- **reasoning run** = `reasoning` | `thinking` (rendered in `TurnBlockStep`, italic prose)
- **activity run** = everything else (text/image/custom rendered directly; tool_use/tool_result
  normalized into ToolViews and rendered as `ToolCard` or `ToolRunBlock`)

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [Design: AI drafts & review](../../../../../../.meridian/git/haowjy-meridian-flow-docs/work/ai-version-branch-review/design.md)
