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
`components/app/work-composer-controls`). Explicit existing-thread Work rebinding stays here as a Chat adapter; prospective
Home selection does not. Work management and navigation must not call or copy
the rebind adapter.

## Mental model

An assistant turn renders as one **ordered list of render items** (see
`partition-turn.ts`), in block order. Each item is one of three tiers:

- **Process** (collapsed) — a contiguous run of reasoning and process tools,
  folded into one `Thinking` disclosure in place. Its visible label becomes a
  deterministic digest when it contains tools.
- **Text** (visible) — an assistant text block, always rendered as prose. Text
  never folds and never remounts.
- **Artifact** (visible) — a writer-facing block: a custom card (`ask_user`
  interrupt, spawn/`thread_message` `helper-result`, child `child-report`), an
  image, or a file.

Text and artifacts close the open process run, so a reasoning run that arrives
after visible prose starts a fresh fold below it instead of merging back above
it. Process tools fold live and settled alike; there is no frontier that waits
for the durable status flip. The partition keys off block order/type only and
never reads transient stream state (`isLive`, partial blocks). Hidden protocol
(the `tool_use`/`tool_result` rows a card already surfaces) is dropped, not
folded.

Run liveness is never a turn block. A background spawn's running card is now a
durable server block on the parent turn (retired at child settle); the durable
report still arrives as its own `helper-result` system-turn block. The live
subagent surface is server truth: `ThreadActivity` from live state (snapshot +
`meridian.subagent.activity`), rendered recursively by `RunningSubagentsStrip`
mounted in `ChatView`'s header. It is anchored to the thread, so a terminal
turn cannot erase it.

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
2. **Process folds live and settled alike.** Reasoning and process tools
   collapse into their `Thinking` disclosure as they stream. There is no
   settlement-time fold and no visible frontier. Text and artifacts never fold.
3. **Artifact cards stay visible.** Custom cards (`ask_user` interrupt, spawn
   `helper-result`, child `child-report`) render through the shared `ArtifactCard`
   shell (`icon`/`tone`/`title`/`door`/`hint`/children); process tools render as
   `ActivityRow`. Their tool protocol is dropped, not folded. The two tool kinds
  are named in `tool-kind.ts`: an artifact's result is writer-facing (custom
  card, image, file); a process tool is scaffolding.
4. **Document names are doors.** `DocumentName.tsx` renders every
   writer-facing document name in the timeline and is the only place that
   decides whether one is a link. Don't add navigation to a renderer, and
   don't make a folder, pattern or skill a door. A row expands, a name
   navigates; never invert that, and never author the name button as a JSX
   child of the row button.
5. **Block render keys are positional.** Use `blockRenderKey(block)` —
   `turnId::sequence`. Never key by `block.id`. Prose, images, and custom cards
   keep identity across streaming because they never change zone; a process fold
   is keyed by its first block.

## Anti-patterns

- **Don't branch on transient streaming state in partition logic.** Partition
  reads block order/type only; `isLive`, partial-block shape, and component-local
  stream state are not inputs.
- **Don't key by `block.id`.** ID spaces can drift between sources; positional
  identity cannot. Use `blockRenderKey`.
- **Don't duplicate tool rendering.** `DeliverySegments` normalizes tool protocol
  blocks into ToolViews for the process fold. No raw tool block should reach
  `TurnBlockStep`.
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

Key contract: **no child of the transcript viewport may own a scroller**.
Assistant turn rendering (`AssistantTurn.tsx`, `ProcessDisclosure.tsx`) owns only
the disclosure expand/collapse — the viewport is TurnList's invariant. The
thread switcher's bounded result list is a separate popover scroller: opening
it scrolls the current chat into view without taking focus from search.

→ TurnList.tsx header comment (single-scroll-owner contract + geometry/policy split)
→ useChatFollowScroll.ts header comment (state machine invariants +
  re-armable 180ms guard + near-bottom-wins ordering)
→ [KB: chat scroll follow-state decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat-scroll-follow-state.md)

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [Requirements: Undo & Draft Review UX](https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/requirements.md)
→ [Editable draft review authority decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/draft-review-editable-branch.md)
→ [QA runtime probes for draft review](../../../../../docs/qa/draft-review.md) — run when changing disposition state, the dock, or the review launcher
