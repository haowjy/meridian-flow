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
new-chat selection does not. Work management and navigation must not call or copy
the rebind adapter.

`CreationComposer` sends through the route-owned pane-aware chat command. It
never writes a URL. The first-send journal survives reload under the remembered
current thread ID, including when creation starts in the dock.

## Mental model

An assistant turn renders as one **ordered list of render items** (see
`partition-turn.ts`), in block order. Each item is one of three tiers:

- **Process** (collapsed) — a contiguous run of reasoning and process tools,
  folded into one `Thinking` disclosure in place. Its visible label becomes a
  deterministic digest when it contains tools.
- **Text** (visible) — an assistant text block, always rendered as prose. Text
  never folds; settlement or partition changes do not remount an already-mounted
  text item. The virtual viewport may still unmount and remount off-screen turns.
- **Artifact** (visible) — a writer-facing block: a custom card (`ask_user`
  interrupt, spawn/`thread_message` `helper-result`), an
  image, or a file.

Text and artifacts close the open process run, so a reasoning run that arrives
after visible prose starts a fresh fold below it instead of merging back above
it. Process tools fold live and settled alike; there is no frontier that waits
for the durable status flip. The partition keys off block order/type only and
never reads transient stream state (`isLive`, partial blocks). Hidden protocol
(the `tool_use`/`tool_result` rows a card already surfaces) is dropped, not
folded.

Run liveness is never a turn block. Each admitted spawn invocation has one
durable retained card on the parent turn. At settlement, the card's status is
the child execution outcome, not parent protocol admission. Foreground cards
join the durable direct `spawn` or `thread_message` result by parent turn, tool
call, child execution and direct delivery mode. Cards branch on the run's
`deliveryMode`, never on which blocks happen to exist: background cards are
one-line launches with the live current tool under them while running, and
once finished they expand to the saved report (read on expansion); direct cards
combine launch, live current tool, and expandable result. `thread_report` is
always a folded process step ("Read report from ..."), in either mode, because
the card is the one surface per run: the step expands to the report, and its
agent name links to the launch card (a `subagentBlock: "card"` reveal).
Background `subagent_update` notices render as quiet rows ("<agent>
<run name> finished"); adjacent completions merge into one disclosure.
Notice text is never repeated there.

Every subagent surface (launch card, running panel, Subagents pop-up, finished
row, report step, path row) builds on the normalized `subagent/SubagentRun`
and the shared `subagent/SubagentRow` anatomy. The mark leads, then the agent
name (generic runs read "Subagent"), then the run's `name` in muted text,
separated only by spacing; never a raw ref. **Only the chat icon
(`OpenSubagentChatButton`, labeled Open "<agent>") opens a child chat**, through
the project chat navigation route, replacing the current chat; chat tabs are
[#606](https://github.com/haowjy/meridian-flow/issues/606). A row or card click expands it or jumps
within the current chat; it never switches threads. A pop-up row jumps through
a block-level conversation reveal to the child's latest point: the finished
row once it completed, else its launch card.

Server activity (snapshot plus `meridian.subagent.activity`) is the viewed
thread's direct children (see `activity-row-anatomy.md`). The shared `useThreadActivity` store owns the
cached live view and one transport subscription per thread; the running panel
shows direct children running in the background, and the Subagents pop-up
lists every direct child.

`subagent/ActivityContext.tsx` indexes activity, invocation cards, and completion
notices by child thread, ref, and execution. A saved running card with no live
lease is `unknown`, not running. `transcript-model.ts` classifies turns and
derives transcript rows, response parts, delivery rows, and reveal targets in
one pass. Rows have kinds (turn, compaction divider, handoff brief card,
`from` reference) and stay index-aligned with the visible turns; grouping
switches on row kind, never on role. Compaction turns are divider rows there,
never in the head; see
[`.context/compaction-surfaces.md`](.context/compaction-surfaces.md). Queued
`/compact` waits at the transcript tail until replies finish. Fork,
handoff, the brief card, and a fork's inherited rows are in
[`.context/fork-and-handoff.md`](.context/fork-and-handoff.md). The handoff
brief is not an inbox command: `derivation/useHandoffBrief.ts` owns its Retry
(an optimistic card after the turn it followed, reconciled by the seed's id) and Stop (turn
cancel on the seed), and a pending seed is the composer's active run. A failed
reply's Retry (`useReplyRetry.ts`) shares that optimistic half
(`useRetryStandIns.ts`); see
[`.context/failed-reply-retry.md`](.context/failed-reply-retry.md). Hand off
also sits under a delivered writer message; Fork stays on replies.

Child completion is a separate durable transcript event: system turns with
`metadata.kind === "subagent_update"` render as a quiet inline row at their
causal position. Its execution UUID is internal correlation to the matching
invocation card; copy comes from structured handle/outcome metadata, never
notice-text parsing. Keep this visibility rule aligned with
`threads/domain/visible-conversation-policy.ts`.

The mounted snapshot-sync hook, not the run controller, owns addressed
`meridian.block.upserted` projection for the whole
mounted thread lifetime. The existing upsert frame also carries historical card
replacements. Update a loaded target turn without touching active-turn state;
when the target turn is absent, invalidate/refetch the durable snapshot rather
than creating a synthetic streaming turn. Store duplicate replacement as a
reference-preserving no-op. The pending inbox remains generic for transport
and model drain. `queuedWriterTurnIds` selects writer-provenance turns whose
delivery state is still `waiting`; only those accepted bubbles show `Queued`.
`awaiting_run` has no inline label because the live indicator already signals a
response is coming. There is no composer queue tray.

The full model lives in
[`.context/turn-composition.md`](.context/turn-composition.md); chat spacing and settled
actions live in [`.context/turn-rhythm-and-actions.md`](.context/turn-rhythm-and-actions.md);
one row's anatomy and its navigation rules in
[`.context/activity-row-anatomy.md`](.context/activity-row-anatomy.md); draft receipts,
composer mode, and review state live in
[`.context/turn-edit-receipts.md`](.context/turn-edit-receipts.md),
[`.context/composer-write-mode.md`](.context/composer-write-mode.md), and
[`../draft-review/.context/draft-review.md`](../draft-review/.context/draft-review.md).

## Key rules

1. **Default-collapsed everywhere.** `Thinking` disclosures are closed by default
   whether streaming live or settled. No auto-open on streaming.
2. **Process folds live and settled alike.** Reasoning and process tools
   collapse into their `Thinking` disclosure as they stream. There is no
   settlement-time fold and no visible frontier. Text and artifacts never fold.
3. **Artifact cards stay visible.** Interrupt cards render through the shared
   `ArtifactCard` shell (`icon`/`tone`/`title`/`door`/`hint`/children); spawn
   `helper-result` cards render through `SubagentRow`; process tools render as
   `ActivityRow`. Their tool protocol is dropped, not folded. The two tool kinds
  are named in `tool-kind.ts`: an artifact's result is writer-facing (custom
  card, image, file); a process tool is scaffolding.
4. **Document names are doors.** `DocumentName.tsx` renders every
   writer-facing document name in the timeline and is the only place that
   decides whether one is a link. Don't add navigation to a renderer, and
   don't make a folder, pattern or skill a door. A row expands, a name
   navigates; never invert that, and never author the name button as a JSX
   child of the row button.
5. **Only a finished turn ends a reply.** A notification-woken continuation, a
   server-stamped steer, or background subagents still running keep the reply
   open: no action row, no exchange gap. `continuesResponse` in
   `transcript-model.ts` is the one rule; see
   [`.context/turn-rhythm-and-actions.md`](.context/turn-rhythm-and-actions.md).
6. **Block render keys are positional.** Use `blockRenderKey(block)` —
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
history, even though the review editor itself stays editable. The review's
provider, controller, command executor, refusal copy and file model are
`features/draft-review`'s; Chat is a consumer (the composer's `DraftDock` strip,
review-prose focus). See
[`../draft-review/.context/draft-review.md`](../draft-review/.context/draft-review.md)
for the lifecycle, execution, preview, and projection contracts.

**The strip is this chat's changes, not the Work's.** `useDraftDock(threadId)`
lists the Work's drafts whose `actorThreads` name the chat, reads each one's
preview (`useDraftPreviews`) and keeps the changes whose `threadIds` include the
chat. A chat with none shows no strip. Apply and Discard send one selection
command per file (the union of this chat's actionable changes, never a whole
draft) through creation-bound `useWorkDraftCommands` batches, which hide every file's selection at the
click and returns each as its own command answers (the strip keeps no hide of
its own); a refusal stays on its file. On a coarse pointer every strip command
is a 44px target, and a dock too narrow for the summary and the commands wraps
the commands under the summary rather than squeezing it. A new
document is Review-only. The notes (a change tied to another chat's edit,
changes only Apply draft or Discard draft handle, a new document) sit above the
commands, collapsed or expanded. Work-wide lists and Apply all live on the Work
page; the strip's last line is the shared `WorkChangesLink` to it.

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
→ [KB: chat scroll follow-state decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/chat/composer/chat-scroll-follow-state.md)

→ [`.context/CONTEXT.md`](.context/CONTEXT.md)
→ [Requirements: Undo & Draft Review UX](https://github.com/haowjy/meridian-flow-docs/blob/main/work/human-undo-affordance/requirements.md)
→ [Editable draft review authority decision](https://github.com/haowjy/meridian-flow-docs/blob/main/kb/decisions/collab/drafts/review/draft-review-editable-branch.md)
→ [QA runtime probes for draft review](../../../../../docs/qa/draft-review.md) — run when changing disposition state, the composer strip, the Work page's Changes to review, or the review launcher
