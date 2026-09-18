# features/chat — Activity/Thinking composition model

How an assistant turn renders: the relationship between the collapsed **`Thinking`**
(process) disclosure and the visible **`ActivityBlock`** (delivery frontier), across the
whole turn lifecycle. This is the implemented contract for the turn render surface.

## Two zones

- **Process fold** — default-collapsed history: every reasoning/thinking block,
  every earlier activity run, and every frontier process-tool operation once the
  turn reaches a durable terminal status. If the fold contains tools, its visible
  label is their deterministic digest; otherwise it reads `Thinking`. A fold with
  no visible content renders no disclosure.
- **`ActivityBlock`** — the live delivery frontier. For a settled turn it keeps
  only non-foldable frontier blocks (text, image, custom, including resolved
  interrupt cards, plus hidden turn-card protocol). A foldable-tools-only settled
  frontier is empty.

The zones are rendered by `ProcessDisclosure.tsx` (fold) and `AssistantTurn.tsx`
(the visible zone, driving `DeliverySegments` → `groupDeliverySegments`).

## Partition rule

**Step 1 — segment at cards.** Split ordered `Block[]` at each interrupt,
helper-result, and child-report card; the card is the final block of its
segment.

**Step 2 — group maximal runs** within each segment:

- **reasoning** = `reasoning` | `thinking`
- **activity** = everything else

An empty reasoning block (no visible `textContent` or `content.text`) is a
provider repair placeholder: the frontend drops it before grouping, so Thinking
is not shown for it and it does not split the activity runs on either side.
A segment left with no blocks after the drop emits no segment.

Earlier activity runs and all remaining reasoning runs go into the fold. The
last activity run is the frontier.

**Step 3 — apply durable settlement.** For live statuses (`pending`, `streaming`,
`waiting_interrupt`), the frontier stays whole and visible. For settled statuses
(`complete`, `cancelled`, `error`), tool protocol blocks from the frontier move
into that segment's fold in chronological position; frontier non-tool blocks
remain visible. An image renders a preview and stays with the frontier.
Turn-card protocol (`ask_user`, `spawn`, `return_result`) never folds: it stays
on the frontier hidden behind its card. Nothing else is exempt. A fold
with only hidden protocol does not show `Thinking`.

The settlement input is the canonical `isTerminalTurnStatus` result. Partition
never reads transient component liveness, partial-block shape, or stream buffers.
A turn's final settled frame and its reload therefore partition identically.

## Lifecycle table

Notation: `r` = reasoning, `p` = prose/custom/image, `t` = tool operation,
`[fold]` = collapsed process disclosure.

| durable state | blocks | visible `ActivityBlock` | process fold |
|---|---|---|---|
| live reasoning | `r0` | empty | `r0` (`Thinking`) |
| live first run | `r0 · p1 t2 p3` | `p1 t2 p3` | `r0` (`Thinking`) |
| live later reasoning | `r0 · p1 t2 · r3` | `p1 t2` | `r0, r3` (`Thinking`) |
| live new frontier | `r0 · p1 t2 · r3 · t4 p5` | `t4 p5` | `r0, (p1 t2), r3` (`Explored…`/outcome digest) |
| settled | same blocks | `p5` | `r0, (p1 t2), r3, t4` (digest includes all tools) |
| settled tools-only frontier | `r0 · t1` | empty | `r0, t1` (digest) |

The live roll-up rule is unchanged: a new activity run moves the previous
frontier into the fold. Settlement adds one final structural move for tool rows
only. Prose and interaction cards do not become process history merely because
the turn ended.

### Digest contract

The label summarizes only ToolViews actually inside that segment's fold. Reads
with document targets contribute unique explored documents; successful writes
contribute edited/drafted documents; unknown, failed, and otherwise
uncountable operations contribute steps. Clauses are ordered explore → edit →
steps. The accessible name remains `Thinking` / `Thinking part N` regardless of
the visible digest.

## Cards segment the turn

Writer-facing cards close a segment: an **interrupt** (`custom` block with
`content.interrupt.id`, via `ask_user`), a **spawn helper-result card**
(`custom` `kind: "helper-result"`), and a **child-report card** (`custom`
`kind: "child-report"`, from `return_result`). Each is the *final block of its
segment*.

Cards hide their tool_use/tool_result rows (`tool-view-visibility.ts`). The
custom card is the surface. Spawn and `return_result` protocol are persisted for
the model; the writer never sees their rows. Parent spawn cards render only from
the helper-result custom block.

After the boundary, later reasoning and prose open a fresh fold/frontier pair
below. A running spawn card is persisted before the child runs, so the live
frontier already shows the card.

When the turn settles, ordinary tool rows fold; interrupt, helper-result, and
child-report cards remain visible.

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

After the user responds, segment 2 begins below. Once the turn settles:

```
> Explored 1 document                         (collapsed, segment 1)
| [0] reasoning
| ActivityBlock([1] text, [2] tool, [3] text)
| [4] reasoning
| [6] tool
ActivityBlock([5] text, [7] interrupt)             ← interaction stays visible

> Thinking                                    (collapsed, segment 2)
| [8] reasoning
ActivityBlock(… segment 2's frontier …)
```

Each segment applies the same durable-settlement rule independently.

## Vocabulary

| Term | Definition |
|---|---|
| **Process fold / `Thinking` disclosure** | The default-collapsed disclosure rendered by `ProcessDisclosure.tsx`. Holds reasoning, completed activity runs, and settled frontier tool rows. Its visible label is a tool digest when possible. |
| **`ActivityBlock` (delivery frontier)** | The live last activity run; after settlement, its non-tool blocks only. Rendered by `AssistantTurn.tsx` → `DeliverySegments`. |
| **Activity run** | A maximal contiguous run of activity blocks (non-reasoning). The last one in a segment is the visible frontier. |
| **Segment** | A subdivision of the turn at card boundaries. Each segment has its own `Thinking` + `ActivityBlock` pair. |
| **Segment boundary** | An interrupt `custom` block, a spawn `helper-result` card, or a `child-report` card. It is the final block of its segment. |
| **Roll-up** | When a new activity run begins, the previous frontier collapses into `Thinking` in its chronological position. |

## Contracts & invariants

### Invariants

- **Default-collapsed everywhere.** `Thinking` disclosures are closed by default whether
  streaming live or settled/reloaded. No `defaultOpen={reasoningStreaming}`.
- **Durable status is the lifecycle seam.** Terminal status folds every segment's
  tool rows. Transient `isLive` and partial-block state never drive partitioning.
- **Interrupt cards stay visible.** Resolution freezes the segment boundary; on
  settle, its tool rows fold but its resolved interrupt card remains visible.
- **Turn-card protocol never folds.** `isFoldableToolBlock` exempts
  `ask_user`, `spawn`, and `return_result` tool blocks like images, so they stay
  on the frontier hidden. The helper-result custom block is the only spawn card.
  The `child-report` card is the same family: it replaces the `return_result`
  protocol, which is hidden behind it after settlement.
- **Block render keys are positional.** `blockRenderKey` derives from
  `(turnId, sequence)`, never `block.id`. Updates within one render zone preserve
  DOM identity. Settlement keeps frontier prose, images, and custom/interrupt
  cards in place, so they do not remount. Tool views alone structurally move from
  the frontier into the process fold and may remount at that boundary.

### What breaks if violated

- Keying the partition off transient streaming state → the final frame and reload
  can disagree.
- Folding a resolved interrupt card → the user loses sight of what they acted on.
- Keying by `block.id` → ordinary within-zone updates can remount DOM nodes,
  losing animation continuity and scroll position.

## Architecture

```mermaid
flowchart TD
    Turn[Turn.blocks: Block[]] --> Sort[sort by sequence]
    Sort --> Segment[segment at cards]
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
  → partitionTurnSegments(sortedBlocks, settled)
                                           ← card segmentation, run grouping,
                                             and terminal tool folding
  → ProcessDisclosure(label, children)     ← default-collapsed fold shell
      → TurnBlockStep | DeliverySegments   ← fold runs in chronological order
  → DeliverySegments(frontier)             ← visible activity frontier per segment
      → groupDeliverySegments(blocks)      ← pair tool_use/tool_result into ToolViews
          → sibling ToolRows | DeliveryBlock
              → CustomBlockRenderer (interrupts)
```

`tool-renderers.tsx` is the registry for tool-name-specific presentation. Registry
keys must be real runtime tool names from
`apps/server/server/domains/runtime/tools/`. The current runtime surface is
`write`, `work`, `ls`, `search`, `ask_user`, `spawn`, and `return_result`.
`ask_user`, `spawn`, and `return_result` render through custom cards
(`choice`/`form`/`free-text`, `helper-result` → `SpawnReportCard`, and
`child-report` → `ChildReportBlock`), all built on the shared `TurnCard` shell
(`icon`/`tone`/`title`/`door`/`hint`/children). Their tool rows are hidden.
Process tools (`write`, `work`, `ls`, `search`) render as `ActivityRow`.
Three conventions govern all renderers:

- **Unknown tools show a humanized name only.** The default renderer displays
  the tool name with underscores replaced by spaces and its first letter
  capitalized — never arguments or paths. Tool arguments are developer detail
  that should not appear in the writer's chat surface.
- **`toolVerb()` for status-aware tense.** Every registered renderer uses
  `toolVerb(tool, completedNode, activeNode)` to conjugate the action label
  by `tool.status` (`complete` vs `partial`). This keeps verb presentation
  consistent and prevents missing-tense bugs when adding new tools.
- **Curated expand content.** Inline expansions render result rows, stream tails,
  or plain output — never raw JSON. If raw JSON is needed for debugging, it goes
  behind a dev-only setting.

Neutral tools (`write`, `work`, `ls`, `search`) get explicit titles/icons and
may expose curated result rows without implying any external execution
substrate. Adding a renderer is a presentation change only: append
the real runtime tool name to the `RENDERERS` map and keep protocol pairing in
`group-delivery-segments.ts`.

Key files:

| File | Role |
|---|---|
| `AssistantTurn.tsx` | Top-level turn render; drives partition + zone mounting |
| `partition-turn-segments.ts` | Structural interrupt segmentation + run grouping for Thinking/Activity zones |
| `group-delivery-segments.ts` | Pairs adjacent tool protocol blocks into ToolViews, then emits single-tool or tool-run segments |
| `ProcessDisclosure.tsx` | Collapsible `Thinking` disclosure with sticky user-toggle state |
| `CustomBlockRenderer.tsx` | Renders `custom` blocks; interrupts pass through `onRespondToInterrupt` |
| `tool-renderers.tsx` | Tool renderer registry; unknown tools show name only, registered tools use `toolVerb()` for tense and may show curated expand content. Mismatched keys don't error — a renamed tool silently falls through to the bare-name default, so verify registry keys against the server tool names when either side changes |
| `AssistantTurn.tsx` (`DeliverySegments`) | Renders adjacent ToolViews as sibling `ToolRow`s |
| `ActivityRow.tsx` | Timeline row primitive: 19px icon gutter where each row paints its own 1px rail segment (no sibling-aware CSS). Exports `ACTIVITY_ROW_TEXT_INSET` so non-row content in the fold (assistant prose) shares the rows' text edge; the rail invariants live in its header comment |
| `TurnBlockStep.tsx` | Compact label/body row for reasoning/prose/image fallback blocks; tools are handled upstream |
| `block-render-key.ts` | Positional render keys — `turnId::sequence` |
| `block-kind.ts` | Block type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `@meridian/contracts` → `threads/index.ts` | `Block`, `BlockType`, `Turn` types |

### Block types (`BlockType` from `@meridian/contracts`)

| BlockType | Kind | Rendered by |
|---|---|---|
| `reasoning`, `thinking` | reasoning run | `TurnBlockStep` (in fold); italic prose in `Markdown variant="compact"` |
| `text` | activity run | `Markdown variant="answer"` (settled) / `StreamingText` (partial) |
| `tool_use`, `tool_result` | activity run | Paired into ToolViews by `groupDeliverySegments`, then rendered as sibling `ToolRow`s by `DeliverySegments` |
| `image` | activity run | `ImageBlock` |
| `custom` | activity run (incl. interrupts) | `CustomBlockRenderer` → component registry |

## Implementation status

Implemented in `partition-turn-segments.ts`, `ProcessDisclosure.tsx`, and
`AssistantTurn.tsx`. The partition returns interrupt-bounded segments where
`foldRuns` contains reasoning, earlier activity runs, and — for settled turns —
the frontier's foldable process-tool blocks. `frontier` contains the complete
last activity run while live and, after settlement, its non-foldable blocks
(non-tool content plus turn-card protocol and images).
`ProcessDisclosure` is a default-collapsed shell; callers compose reasoning rows
and folded activity runs.
