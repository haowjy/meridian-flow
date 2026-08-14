# features/chat — Turn render surface + transcript viewport

The chat frontend: assistant-turn rendering, transcript scrolling, and the
existing-thread adapters and review orchestration around shared composer
controls.

## Purpose

This directory owns the **assistant turn render surface** — the components and
partition logic that convert an ordered `Block[]` (from `@meridian/contracts` `Turn`)
into what the reader sees — and the **transcript viewport** (`TurnList.tsx`), the
single scroll container for the conversation. It is NOT the chat session,
thread management, or shared Composer and Work-control presentation — those are
adjacent concerns (`useChatThreadSession`, `components/app/composer`, and
`components/app/work-composer-controls`). Existing-thread Work rebinding stays
here as a Chat adapter; prospective Home selection does not.

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
[`.context/turn-composition.md`](.context/turn-composition.md); one row's
anatomy and its navigation rules in
[`.context/activity-row-anatomy.md`](.context/activity-row-anatomy.md); draft receipts,
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
4. **Document names are doors.** `DocumentName.tsx` renders every
   writer-facing document name in the timeline and is the only place that
   decides whether one is a link. Don't add navigation to a renderer, and
   don't make a folder, pattern or skill a door. A row expands, a name
   navigates; never invert that, and never author the name button as a JSX
   child of the row button.
5. **Block render keys are positional.** Use `blockRenderKey(block)` —
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

## Draft-review boundary

Inline review is the only draft-review surface. It uses server-backed
Apply/Discard disposition commands; dispositions never ride browser mutation
history, even though the review editor itself stays editable. See
[`.context/draft-review.md`](.context/draft-review.md) for the lifecycle, session,
preview, and projection contracts.

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
→ [Editable draft review authority decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-review-editable-branch.md)
→ [QA runtime probes for draft review](../../../../../docs/qa/draft-review.md) — run when changing disposition state, the dock, or the review launcher
