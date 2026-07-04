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
| `TurnChangeFooter.tsx` | Per-turn summary bar below settled undoable turns: server live-lineage document list with per-document and whole-turn undo/redo controls |
| `block-render-key.ts` | Positional render keys |
| `block-kind.ts` | Type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `DraftReviewCard.tsx` | Chat-anchored review card for AI drafts; renders per-draftId using `ComponentCard` shell |
| `DraftReviewBar.tsx` | In-editor review affordance under the toolbar; consumes `useDraftReview()`. Three shapes: (a) **entry banner** — single-line `AI drafted changes` + primary `Open AI draft` (routes through `useAiDraftLauncher`); (b) **slim during-review bar** — `Reviewing draft` + `N operations · M regions` + `Cancel` + `Apply all`; (c) **terminal compact undo bar** — `Draft applied` / `Draft discarded` + `Undo`. One signal, one primary per shape. |
| `DraftReviewCard.tsx` | Chat-side one-line draft bar (`<doc> has changes` + primary `Review`, quiet `Apply` / `Discard`). Anchored rows may show terminal undo receipts; the composer dock is active-only. |
| `DraftPreviewOverlay.tsx` | Fallback right-docked sheet when a writer opens a draft from a surface without an editor mount. Header summarizes `N changes proposed to <doc>`; footer verbs are `Close preview` / `Discard draft` / `Apply draft`. No dim modal on desktop. |
| `useAiDraftLauncher.ts` | Shared `openAiDraft(group, draftId)` used by the entry banner and the chat card. Captures the pre-review rail state at module scope (the launcher's owner unmounts across navigation, so a `useRef` snapshot doesn't survive), navigates to `?screen=context&scheme=manuscript&path=/<doc>`, collapses `rail-l` + `dock`, calls `enterInlineReview`. On exit, the effect restores whatever rail state we found. |
| `DraftReviewProvider.tsx` | Project-shell context plumbing: exposes the draft review session controller (carrying the focused threadId for thread-cache invalidation), work draft groups, and editor-host presence |
| `useDraftReviewController.ts` | One client review-session owner: active surface/selection, stale/overlap/cannot-place/fallback, whole-draft commands, per-operation accept/discard/undo command state |
| `draft-review-controller-transitions.ts` | Pure review-session reducer for panel/inline surface, overlap/stale/fallback, terminal cannot-place (whole-draft and per-operation), closure confirmations, inline messages, and per-draft discard pending state |
| `inline-review-discard-operation.ts` | Session-owned per-operation discard implementation: journal cache, freshness retry, Yjs inverse update application |
| `DraftDiffPanel.tsx` | Docked line-level prose diff (shared by bar and chat cards); uses `diff-lines.ts` |
| `DraftIndicatorChip.tsx` | Cross-thread active draft count chip; `FileText` + numeral, additive to lifecycle |
| `ComponentCard.tsx` | Shared token-driven shell for component blocks and draft review cards; three states: pending, resolved, reversible |
| `is-draft-undoable.ts` | Shared expiry rule for applied/discarded draft undo affordances |
| `diff-lines.ts` | LCS line-level diff for prose diffs |
| `anchor-drafts.ts` | Splits draft groups by producing assistant turn `lastActorTurnId` |
| `DockedDraftReviewStack.tsx` / `docked-drafts.ts` | Composer dock assembly: active drafts only, one row at rest; multiple active documents collapse to `N documents have AI changes` with expandable per-document rows. |

## Draft review lifecycle

Inline review applies the same whole-draft `acceptDraft` path as the docked panel.
The controller is the single client review-session owner. Its reducer owns
`surface: none | panel | inline`, the active `{ documentId, draftId }`, overlap
confirmation payload, stale-draft message target, hard-fallback dedupe, operation
closure confirmations, inline accept/undo/discard messages, and inline discard
pending state. Use controller transitions instead of pairing local `close` calls;
`exitReview` is the single clear-all path.

On success, `applySucceeded` clears the active surface so the editor rebinds from
the draft room back to the live manuscript room. If accept returns
`status: "overlap"`, inline review exits and the docked panel becomes the
confirmation surface using the returned `liveRevisionToken`; the next Apply
confirms with `confirmedLiveRevisionToken`. Whole-draft discard uses the same
cleanup path.

`DraftReviewSidebar` is a view over plugin artifacts plus session state. It may
keep ephemeral view plumbing such as card DOM refs for focus/scroll, but not
review-session state: no mutation hooks, no discard timers, no confirmation or
message bookkeeping. It dispatches controller commands for operation accept,
cancel/confirm, discard, and undo.

`useInlineReviewSync` is a plugin adapter only: it pushes server hunk models into
the TipTap inline-review extension and reports model availability identities. The
session controller decides whether a missing model becomes a hard fallback.

Per-operation inline Discard is serialized separately from whole-draft Apply. While a
proposal discard is pending/settling for a draft, Apply buttons are disabled with
"Finishing discard…" so a final accept cannot race a local reject update. That
pending state, the 4.5s stickiness timer, freshness retry, and journal cache live
in the controller/session path, keyed by draft id; do not add module-global or
component-local review/discard state.

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
