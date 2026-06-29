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

**Step 1 — segment at checkpoints.** Split the turn's ordered `Block[]` into **segments**
at each **checkpoint** (user-interaction / HITL) block: a checkpoint block is the *final*
block of its segment. A turn with no checkpoints is one segment. Segments **stack
vertically**, each rendered independently.

**Step 2 — within each segment**, group its blocks into **maximal runs** by kind:

- **reasoning** = `reasoning` | `thinking`
- **activity** = everything else (`text`, `tool_use`, `tool_result`, `image`, `custom`,
  and the **checkpoint** block, which is an activity block — the segment's frontier)

Then, per segment:

- The **last activity run** is the visible **`ActivityBlock`** for that segment.
- **Everything else** in the segment — every reasoning block *and* every earlier activity
  run — renders **inside that segment's default-collapsed `Thinking ptN` disclosure, in
  chronological order**.
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

## Checkpoints segment the turn

A **checkpoint** (user-interaction / HITL block — a `custom` block resolved via
`onRespondToCheckpoint` in `CustomBlockRenderer.tsx`) is a **segment boundary**. It is the
*final block of its segment* and the **frontier** of that segment's `ActivityBlock` (the
round is waiting on the user).

After the user responds:

- The segment's `ActivityBlock` (including the checkpoint) is **frozen — kept expanded,
  never rolled up.** The reader must keep seeing what they acted on.
- The continuation opens a **fresh `Thinking ptN+1`** disclosure *below*, and a new
  `ActivityBlock` — a new stacked segment.

A turn renders as a **vertical stack of `(Thinking ptN  +  ActivityBlock)` segments**,
one per checkpoint round. There can be **multiple visible `ActivityBlock`s** (one per
segment) — not just one.

### Worked example (checkpoint round)

Before the user responds — one segment, checkpoint `c7` is the frontier:

```
> Thinking                                    (collapsed)
| [0] reasoning
| ActivityBlock([1] text, [2] tool, [3] text)
| [4] reasoning
ActivityBlock([5] text, [6] tool, [7] checkpoint ← awaiting user)
```

After the user responds, segment 1 is **frozen as-is** and segment 2 begins below:

```
> Thinking                                    (collapsed, segment 1)
| [0] reasoning
| ActivityBlock([1] text, [2] tool, [3] text)
| [4] reasoning
ActivityBlock([5] text, [6] tool, [7] checkpoint)   ← kept, frozen

> Thinking pt2                                (collapsed, segment 2)
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
| **Segment** | A subdivision of the turn at checkpoint boundaries. Each segment has its own `Thinking ptN` + `ActivityBlock` pair. |
| **Checkpoint boundary** | A `custom` block that partitions segments. It is the final block of its segment. |
| **Roll-up** | When a new activity run begins, the previous frontier collapses into `Thinking` in its chronological position. |

## Contracts & invariants

### Invariants

- **Default-collapsed everywhere.** `Thinking` disclosures are closed by default whether
  streaming live or settled/reloaded. No `defaultOpen={reasoningStreaming}`.
- **Streaming ≡ settled.** The composition rule depends only on `Block[]` order + block
  type. A settled reload produces the same render structure as the live stream. No
  `isLive` branching in the partition logic.
- **Checkpoint segments are frozen.** Once a user responds to a checkpoint, that
  segment's `ActivityBlock` (including the checkpoint) stays expanded forever — it
  is never rolled up into a later segment's `Thinking`.
- **Block render keys are positional.** `blockRenderKey` derives from `(turnId, sequence)`,
  never `block.id`. This ensures the live→settled swap is an in-place content replace, not
  a remount.

### What breaks if violated

- Branching on streaming state in the partition → settled reload shows a *different*
  structure than the user saw live (the classic "page refresh rearranges the turn" bug).
- Rolling a checkpoint frontier into `Thinking` → user loses sight of what they acted on,
  breaking the interaction contract.
- Keying by `block.id` → the live→settled swap remounts DOM nodes, losing animation
  continuity and scroll position.

## Architecture

```mermaid
flowchart TD
    Turn[Turn.blocks: Block[]] --> Sort[sort by sequence]
    Sort --> Segment[segment at checkpoints]
    Segment --> S1[Segment 1]
    Segment --> S2[Segment 2]
    S1 --> Group1[group into maximal reason/activity runs]
    S2 --> Group2[group into maximal reason/activity runs]
    Group1 --> Render1["Thinking pt1 (fold) + ActivityBlock (visible)"]
    Group2 --> Render2["Thinking pt2 (fold) + ActivityBlock (visible)"]
```

Current code path:

```
AssistantTurn.tsx
  → partitionTurnSegments(sortedBlocks)    ← checkpoint segmentation + run grouping
  → ProcessDisclosure(label, children)     ← default-collapsed fold shell
      → TurnBlockStep | DeliverySegments   ← fold runs in chronological order
  → DeliverySegments(frontier)             ← visible activity frontier per segment
      → groupDeliverySegments(blocks)      ← pair tool_use/tool_result into ToolViews
          → ToolCard | ToolRunBlock | DeliveryBlock
              → CustomBlockRenderer (checkpoints)
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
| `partition-turn-segments.ts` | Structural checkpoint segmentation + run grouping for Thinking/Activity zones |
| `group-delivery-segments.ts` | Pairs adjacent tool protocol blocks into ToolViews, then emits single-tool or tool-run segments |
| `ProcessDisclosure.tsx` | Collapsible `Thinking` disclosure with sticky user-toggle state |
| `CustomBlockRenderer.tsx` | Renders `custom` blocks; checkpoints pass through `onRespondToCheckpoint` |
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
| `custom` | activity run (incl. checkpoints) | `CustomBlockRenderer` → component registry |

## Implementation status

Implemented in `partition-turn-segments.ts`, `ProcessDisclosure.tsx`, and
`AssistantTurn.tsx`. The partition returns checkpoint-bounded segments where
`foldRuns` contains all non-frontier runs and `frontier` contains the last
activity run. `ProcessDisclosure` is a default-collapsed shell; callers compose
reasoning rows and folded activity runs.

Migration is tracked in `work/activity-thinking-model`.

## Turn change footer (`TurnChangeFooter.tsx`)

A per-turn summary bar below each settled assistant turn that shows which documents
were touched by write/edit tool calls and surfaces per-document and whole-turn
undo/redo controls. Key behavior:

- **Document extraction** — `turnWrittenDocuments(turn)` scans the turn's `Block[]`
  for write/edit tool calls and gathers the unique set of `{ uri, path }` documents.
- **Per-document undo/redo** — each document row shows Undo (or Redo if already
  reversed). Calls the `POST /api/threads/:threadId/context/reverse` endpoint with
  `{ uri, direction, scope: "write" }`.
- **Whole-turn undo/redo all** — the "Undo all" / "Redo all" button calls the same
  endpoint with `{ direction, scope: "turn", target: turnId }`, which runs
  `reverseTurn` across every document the turn touched.
- **Local state** — the footer tracks per-document affordance state locally
  (`applied` | `reversed` | `disabled`). Document content refresh after reversal is
  handled by Yjs sync; the footer doesn't manage editor state.
- **Aggregate status** — when all actionable documents are reversed, the summary
  shows "(all undone)" and the bulk button flips to Redo.

State transitions from server results map `reversed`/`reconciled` → `reversed`
(after undo) or `applied` (after redo), `nothing_to_undo`/`nothing_to_redo` →
pass-through, `expired` → `disabled` with "Can no longer be undone" text,
`cant_undo_dependent` → keeps current disposition with "A later edit depends on
this" message.

## Related (separate but adjacent)

- **Default-tool renderer + arg streaming** — DONE. `groupDeliverySegments` normalizes
  live merged tools and durable `tool_use`+`tool_result` pairs into ToolViews before
  rendering. The three-tier tool model (default → registered → generative) remains broader scope.
- **catchup-fidelity** — DONE. Guarantees settled turns reconstruct the same `Block[]`
  from the durable snapshot. This model relies on that guarantee.
- **AI draft review UX** — DONE. Draft review is chat-first: `DraftReviewCard` anchors
  to the producing assistant turn via `lastActorTurnId`; `DraftPreviewOverlay` (owned
  by `ChatView`, not by the card row) shows a line-level prose diff. Stack-ready
  grouping by `documentId`. See [design doc](../../../../../../../.meridian/git/haowjy-meridian-flow-docs/work/ai-version-branch-review/design.md).

## Don't

- Don't branch on `isLive`/streaming state in the partition logic — the rule must be
  purely structural so settled reloads match.
- Don't key blocks by `block.id` — use `blockRenderKey` (`turnId::sequence`).
- Don't roll checkpoint segments into a later segment's `Thinking` — they are frozen.
- Don't auto-open `Thinking` disclosures during streaming — default-collapsed everywhere.
- Don't duplicate tool rendering logic between the fold and the activity zone —
  `DeliverySegments` handles tools for folded activity runs and visible frontiers via
  ToolViews; raw tool blocks must not reach `TurnBlockStep`.
