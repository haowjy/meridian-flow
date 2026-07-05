# features/chat — Activity/Thinking composition model

How an assistant turn renders: the relationship between the collapsed **`Thinking`**
(process) disclosure and the visible **`ActivityBlock`** (delivery frontier), across the
whole turn lifecycle. This is the implemented contract for the turn render surface.

## Two zones

- **`Thinking`** — a disclosure holding *process history*: every reasoning/thinking
  block, AND every **completed (non-latest) activity run**. **Default-collapsed
  everywhere** (live and settled). One click reveals the full chronological transcript.
- **`ActivityBlock`** — the **live delivery frontier**: the single most-recent run of
  delivered content the reader is focused on.

The zones are rendered by `ProcessDisclosure.tsx` (the fold) and `AssistantTurn.tsx`
(the activity zone, driving `DeliverySegments` → `groupDeliverySegments`).

## The unified rule (purely structural)

**Step 1 — segment at interrupts.** Split the turn's ordered `Block[]` into **segments**
at each **interrupt** (user-interaction / HITL) block: a interrupt block is the *final*
block of its segment. A turn with no interrupts is one segment. Segments **stack
vertically**, each rendered independently.

**Step 2 — within each segment**, group its blocks into **maximal runs** by kind:

- **reasoning** = `reasoning` | `thinking`
- **activity** = everything else (`text`, `tool_use`, `tool_result`, `image`, `custom`,
  and the **interrupt** block, which is an activity block — the segment's frontier)

Then, per segment:

- The **last activity run** is the visible **`ActivityBlock`** for that segment.
- **Everything else** in the segment — every reasoning block *and* every earlier activity
  run — renders **inside that segment's default-collapsed `Thinking` disclosure, in
  chronological order**. Multiple segment folds use the same label; their position in the
  transcript carries the sequence.
- A segment with no activity yet (only reasoning) → empty `ActivityBlock`.

Because the rule depends only on **block order + type** (never on streaming state), a
**settled/reloaded turn renders byte-for-byte the same structure** as it did live.

## Lifecycle table (6 states)

Notation: `r#` = reasoning block, `a#` = activity block. `[fold]` = collapsed `Thinking`.

| # | event | blocks | visible `ActivityBlock` | `Thinking` (collapsed) |
|---|---|---|---|---|
| 1 | model starts thinking | `r0` | `()` empty | `r0` |
| 2 | thinking done → first delivery | `r0 · a1` | `(a1)` | `r0` |
| 3 | tool call | `r0 · a1 a2` | `(a1, a2)` | `r0` |
| 4 | more text | `r0 · a1 a2 a3` | `(a1, a2, a3)` | `r0` |
| 5 | model thinks again | `r0 · a1 a2 a3 · r4` | `(a1, a2, a3)` *(still last activity run)* | `r0, r4` |
| 6 | delivers again | `r0 · a1 a2 a3 · r4 · a5` | `(a5)` | `r0, AB(a1,a2,a3), r4` |

- **5 → 6 is the roll-up:** when a new activity run (`a5`) begins, the previous frontier
  `(a1,a2,a3)` collapses **up into `Thinking`**, slotted in chronological order between
  `r0` and `r4`. Completed **activity runs** roll up, not just reasoning.
- **State 5 transient:** while `r4` streams and no new activity has followed, the prior
  activity run `(a1,a2,a3)` stays visible below the fold even though `r4` (chronologically
  later) shows inside the fold above it. This momentary out-of-order is a natural
  consequence of the structural rule (last *activity* run = `(a1,a2,a3)` until `a5`
  exists) — no special-casing required.

## Interrupts segment the turn

A **interrupt** (user-interaction / HITL block — a `custom` block resolved via
`onRespondToInterrupt` in `CustomBlockRenderer.tsx`) is a **segment boundary**. It is the
*final block of its segment* and the **frontier** of that segment's `ActivityBlock` (the
round is waiting on the user).

After the user responds:

- The segment's `ActivityBlock` (including the interrupt) is **frozen — kept expanded,
  never rolled up.** The reader must keep seeing what they acted on.
- The continuation opens a **fresh `Thinking`** disclosure *below*, and a new
  `ActivityBlock` — a new stacked segment.

A turn renders as a **vertical stack of `(Thinking + ActivityBlock)` segments**,
one per interrupt round. There can be **multiple visible `ActivityBlock`s** (one per
segment) — not just one.

### Worked example (interrupt round)

Before the user responds — one segment, interrupt `c7` is the frontier:

```
> Thinking                                    (collapsed)
| [0] reasoning
| ActivityBlock([1] text, [2] tool, [3] text)
| [4] reasoning
ActivityBlock([5] text, [6] tool, [7] interrupt ← awaiting user)
```

After the user responds, segment 1 is **frozen as-is** and segment 2 begins below:

```
> Thinking                                    (collapsed, segment 1)
| [0] reasoning
| ActivityBlock([1] text, [2] tool, [3] text)
| [4] reasoning
ActivityBlock([5] text, [6] tool, [7] interrupt)   ← kept, frozen

> Thinking                                    (collapsed, segment 2)
| [8] reasoning
ActivityBlock(… segment 2's frontier …)
```

Within each segment the same run-grouping rule applies (last activity run visible; rest
folds into that segment's `Thinking`). This is identical live vs. settled.

## Vocabulary

| Term | Definition |
|---|---|
| **Process fold / `Thinking` disclosure** | The collapsible disclosure rendered by `ProcessDisclosure.tsx`. Holds process history: all reasoning blocks + all completed (non-latest) activity runs. Default-collapsed everywhere. |
| **`ActivityBlock` (delivery frontier)** | The visible zone for the last activity run in a segment. Rendered inline by `AssistantTurn.tsx` → `DeliverySegments`. |
| **Activity run** | A maximal contiguous run of activity blocks (non-reasoning). The last one in a segment is the visible frontier. |
| **Segment** | A subdivision of the turn at interrupt boundaries. Each segment has its own `Thinking` + `ActivityBlock` pair. |
| **Interrupt boundary** | A `custom` block that partitions segments. It is the final block of its segment. |
| **Roll-up** | When a new activity run begins, the previous frontier collapses into `Thinking` in its chronological position. |

## Contracts & invariants

### Invariants

- **Default-collapsed everywhere.** `Thinking` disclosures are closed by default whether
  streaming live or settled/reloaded. No `defaultOpen={reasoningStreaming}`.
- **Streaming ≡ settled.** The composition rule depends only on `Block[]` order + block
  type. A settled reload produces the same render structure as the live stream. No
  `isLive` branching in the partition logic.
- **Interrupt segments are frozen.** Once a user responds to a interrupt, that
  segment's `ActivityBlock` (including the interrupt) stays expanded forever — it
  is never rolled up into a later segment's `Thinking`.
- **Block render keys are positional.** `blockRenderKey` derives from `(turnId, sequence)`,
  never `block.id`. This ensures the live→settled swap is an in-place content replace, not
  a remount.

### What breaks if violated

- Branching on streaming state in the partition → settled reload shows a *different*
  structure than the user saw live (the classic "page refresh rearranges the turn" bug).
- Rolling a interrupt frontier into `Thinking` → user loses sight of what they acted on,
  breaking the interaction contract.
- Keying by `block.id` → the live→settled swap remounts DOM nodes, losing animation
  continuity and scroll position.

## Architecture

```mermaid
flowchart TD
    Turn[Turn.blocks: Block[]] --> Sort[sort by sequence]
    Sort --> Segment[segment at interrupts]
    Segment --> S1[Segment 1]
    Segment --> S2[Segment 2]
    S1 --> Group1[group into maximal reason/activity runs]
    S2 --> Group2[group into maximal reason/activity runs]
    Group1 --> Render1["Thinking (fold) + ActivityBlock (visible)"]
    Group2 --> Render2["Thinking (fold) + ActivityBlock (visible)"]
```

Current code path:

```
AssistantTurn.tsx
  → partitionTurnSegments(sortedBlocks)    ← interrupt segmentation + run grouping
  → ProcessDisclosure(label, children)     ← default-collapsed fold shell
      → TurnBlockStep | DeliverySegments   ← fold runs in chronological order
  → DeliverySegments(frontier)             ← visible activity frontier per segment
      → groupDeliverySegments(blocks)      ← pair tool_use/tool_result into ToolViews
          → ToolCard | ToolRunBlock | DeliveryBlock
              → CustomBlockRenderer (interrupts)
```

`tool-renderers.tsx` is the registry for tool-name-specific presentation. Unknown
tools fall back to the static default renderer; neutral tools such as `read`,
`write`, `edit`, `search`, and `bash` get explicit titles/icons and may expose
`streamOrOutput` or result rows without implying any external execution
substrate. Adding a renderer is a presentation change only: append to the
`RENDERERS` map and keep protocol pairing in `group-delivery-segments.ts`.

Key files:

| File | Role |
|---|---|
| `AssistantTurn.tsx` | Top-level turn render; drives partition + zone mounting |
| `partition-turn-segments.ts` | Structural interrupt segmentation + run grouping for Thinking/Activity zones |
| `group-delivery-segments.ts` | Pairs adjacent tool protocol blocks into ToolViews, then emits single-tool or tool-run segments |
| `ProcessDisclosure.tsx` | Collapsible `Thinking` disclosure with sticky user-toggle state |
| `CustomBlockRenderer.tsx` | Renders `custom` blocks; interrupts pass through `onRespondToInterrupt` |
| `tool-renderers.tsx` | Tool renderer registry; unknown tools use the default renderer, known neutral tools can show streamed or settled output |
| `ToolRunBlock.tsx` | Collapsed disclosure for adjacent ToolView runs |
| `TurnBlockStep.tsx` | Compact label/body row for reasoning/prose/image fallback blocks; tools are handled upstream |
| `block-render-key.ts` | Positional render keys — `turnId::sequence` |
| `block-kind.ts` | Block type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `@meridian/contracts` → `threads/index.ts` | `Block`, `BlockType`, `Turn` types |

### Block types (`BlockType` from `@meridian/contracts`)

| BlockType | Kind | Rendered by |
|---|---|---|
| `reasoning`, `thinking` | reasoning run | `TurnBlockStep` (in fold); italic prose in `Markdown variant="compact"` |
| `text` | activity run | `Markdown variant="answer"` (settled) / `StreamingText` (partial) |
| `tool_use`, `tool_result` | activity run | Paired into ToolViews by `groupDeliverySegments`, then rendered by `ToolCard` or `ToolRunBlock` |
| `image` | activity run | `ImageBlock` |
| `custom` | activity run (incl. interrupts) | `CustomBlockRenderer` → component registry |

## Implementation status

Implemented in `partition-turn-segments.ts`, `ProcessDisclosure.tsx`, and
`AssistantTurn.tsx`. The partition returns interrupt-bounded segments where
`foldRuns` contains all non-frontier runs and `frontier` contains the last
activity run. `ProcessDisclosure` is a default-collapsed shell; callers compose
reasoning rows and folded activity runs.

Migration is tracked in `work/activity-thinking-model`.

## Turn edits card (`TurnEditsCard.tsx`)

An inert per-turn record below each settled assistant turn that edited
documents: a default-collapsed card (`rounded-lg border bg-surface-subtle`)
whose header carries only the count — `✎ Edited N documents` — expanding to
the per-document list. Created files count like any edit (creation flows
through the same agent-edit write path and produces mutation rows). Rows come
from turn lineage in BOTH scopes (`live` + `draft` via `useTurnLiveLineage`).
It carries exactly one control — the transient `Undo` (canon verb): the
whole-turn undo/redo for live-scope lineage, or the ephemeral "just applied"
chip after a dock/editor Apply (session-local; any navigation clears it; only
live-scope rows may suppress the chip). INVARIANT: record, not control panel —
no Review/Apply/Discard here; pending changes belong to the composer-attached
`DraftDock`.

**Two-mode undo model.** The conversation has two distinct undo systems — same
Yjs reversal engine, different scope and interaction pattern:

| Mode | Per-turn receipt | Undo behavior |
|---|---|---|
| **Auto-apply** (`direct`) | ActivityRow with [Undo] button | Reverses the Yjs mutation; creates a synthetic transcript turn ("You undid changes to …") with Redo. The synthetic turn is client-local until the writer moves on. |
| **Draft mode** (`draft`) | 1-line informational receipt | Undo removes this turn's contribution from the accumulated draft. The actionable surface is the composer-attached `DraftDock`; the dock `Changes` view and the editor's `DraftReviewHeader` carry review. |

Turn edits line behavior in auto-apply mode:

- **Document authority** — `AssistantTurn` calls `useTurnLiveLineage(threadId,
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

## Related (separate but adjacent)

- **Default-tool renderer + arg streaming** — DONE. `groupDeliverySegments` normalizes
  live merged tools and durable `tool_use`+`tool_result` pairs into ToolViews before
  rendering. The three-tier tool model (default → registered → generative) remains broader scope.
- **catchup-fidelity** — DONE. Guarantees settled turns reconstruct the same `Block[]`
  from the durable snapshot. This model relies on that guarantee.
- **AI draft review UX** — DONE. Surfaces share one server-backed draft state:
  the composer-attached `DraftDock` (work-scoped, the single actionable strip for
  pending changes), the dock `Changes` view (`DockChangesView`, document groups +
  per-op rows for the reviewed document), and the editor's `DraftReviewHeader`
  (full-width review chrome: Back to live / Apply all / Discard all). All consume
  `DraftReviewProvider` from the project shell. Client review-session state has
  one owner: `useDraftReviewController` + `draft-review-controller-transitions.ts`.
  That session owns active inline selection, whole-draft overlap/stale/fallback,
  and — for the dock Changes cards' per-card Apply/Discard — closure/discard
  confirmations, inline messages, discard timers, and the inline discard journal
  cache (`inline-review-discard-operation.ts`). Editor-side code only adapts runtime
  inputs: `useInlineReviewSync` pushes/reports plugin models; the dock cards drive
  the manuscript through `controller.focusReviewOperation` and settle changes
  through `controller.acceptOperation` / `controller.discardOperation`. See the
  [requirements doc](../../../../../../../.meridian/git/haowjy-meridian-flow-docs/work/human-undo-affordance/requirements.md)
  for design decisions and the
  [draft review lifecycle decision](../../../../../../../.meridian/git/haowjy-meridian-flow-docs/kb/decisions/draft-review-lifecycle.md)
  for architecture.

## Don't

- Don't branch on `isLive`/streaming state in the partition logic — the rule must be
  purely structural so settled reloads match.
- Don't key blocks by `block.id` — use `blockRenderKey` (`turnId::sequence`).
- Don't roll interrupt segments into a later segment's `Thinking` — they are frozen.
- Don't auto-open `Thinking` disclosures during streaming — default-collapsed everywhere.
- Don't duplicate tool rendering logic between the fold and the activity zone —
  `DeliverySegments` handles tools for folded activity runs and visible frontiers via
  ToolViews; raw tool blocks must not reach `TurnBlockStep`.

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
