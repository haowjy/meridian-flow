# features/chat — Process/Text/Artifact composition model

How an assistant turn renders: an ordered list of **process**, **text**, and
**artifact** items. This is the implemented contract for the turn render surface.

## Three tiers

An assistant turn is **one ordered list** of render items, in block order. Each
item is exactly one tier:

- **Process** — a contiguous run of reasoning (`reasoning`/`thinking`) and
  process tools. Collapsed into one `Thinking` disclosure, in place. Its visible
  label is the deterministic tool digest when it holds tools; otherwise
  `Thinking`. Default-collapsed.
- **Text** — an assistant `text` block. Always rendered as prose. Never folded,
  never remounted.
- **Artifact** — a writer-facing block: a custom card (interrupt, spawn
  `helper-result`, child `child-report`), an image, or a file. Always rendered.

The tiers are named in `tool-kind.ts`: an **artifact** result is writer-facing
and never folds; a **process** tool is scaffolding (reads, searches, shell) and
belongs in the fold.

Text and artifacts **close the open process run**. A reasoning run that arrives
after visible prose therefore starts a fresh fold *below* it instead of merging
back *above* it, and prose never rolls into a fold.

## Partition rule

`partitionTurn(sortedBlocks)` walks the ordered `Block[]` once:

1. **Reasoning** with visible text appends to the open process run as a
   `reasoning` run. Empty reasoning is a provider repair placeholder and is
   dropped; it neither opens an empty fold nor splits the runs around it.
2. **Process tools** (`tool_use`/`tool_result` not hidden, not an image) append
   to the open run as an `activity` run. Adjacent tools pair into ToolViews at
   render time.
3. **Hidden protocol** — a `tool_use`/`tool_result` whose row a custom card
   already surfaces (`ask_user`, `spawn`, `return_result`) — is dropped, not
   folded.
4. **An `image` block and a `file` block are artifacts** (`isArtifactBlock`).
5. **Text** flushes the open run and emits a `text` item. Empty text is dropped.
6. **Custom cards** flush the open run and emit an `artifact` item.
7. `activity` blocks (AG-UI progress placeholders under a non-canonical
   blockType) are dropped.

- **reasoning** = `reasoning` | `thinking`
- **activity** = everything else

An empty reasoning block (no visible `textContent` or `content.text`) is a
provider repair placeholder: the frontend drops it before grouping, so Thinking
is not shown for it and it does not split the activity runs on either side.

There is no settlement step. Process folds live and settled alike; the partition
never reads the durable terminal status. A turn's first frame and its reload
partition identically.

## Lifecycle table

Notation: `r` = reasoning, `t` = process tool, `p` = prose, `c` = custom card,
`i` = image. `[ ]` = one collapsed process item.

| blocks | render items |
|---|---|
| `r0` | `[r0]` |
| `r0 t1` | `[r0, t1]` |
| `r0 p1` | `[r0], p1` |
| `r0 t1 p2 t3` | `[r0, t1], p2, [t3]` |
| `r0 p1 r2` | `[r0], p1, [r2]` |
| `r0 c1 r2` | `[r0], c1, [r2]` |
| `spawnUse t1 spawnCard c1` | `c1` (protocol dropped) |
| `image i0` | `i0` |
| `r0` (empty) | *(nothing)* |

### Digest contract

The label summarizes the `write` tools inside that process item: reads with
document targets contribute unique explored documents, and successful writes
contribute edited/drafted documents. Failed operations and every non-`write`
tool (`search`, `ls`, `work`) contribute steps instead of documents. Clauses are
ordered explore → edit → steps. A process item with no readable tool but a
reasoning run still shows `Thinking`. The accessible name remains `Thinking` /
`Thinking part N` regardless of the visible digest.

## Cards are artifacts

Writer-facing cards are custom blocks: an **interrupt** (`content.interrupt.id`,
via `ask_user`), a **spawn helper-result card** (`kind: "helper-result"`), and a
**child-report card** (`kind: "child-report"`, from `return_result`).

Cards hide their tool_use/tool_result rows (`tool-view-visibility.ts`). The
custom card is the surface. Spawn and `return_result` protocol are persisted for
the model; the writer never sees their rows. Parent spawn cards render only from
the helper-result custom block.

Foreground persists a running helper-result card before the child runs, so it
appears as soon as the parent turn holds the block. Background posts the card
on a later system turn after the child completes; the parent shows nothing
while that child runs.

## Vocabulary

| Term | Definition |
|---|---|
| **Process item / `Thinking` disclosure** | The default-collapsed disclosure rendered by `ProcessDisclosure.tsx`. Holds a contiguous run of reasoning and process tools. Its visible label is a tool digest when possible. |
| **Text item** | An assistant `text` block rendered as prose (`Markdown` settled, `StreamingText` partial). |
| **Artifact item** | A writer-facing custom card, image, or file. |
| **Process run** | A `reasoning` or `activity` run inside a process item. |
| **Artifact boundary** | A card, image, or file that closes the open process run, so later reasoning opens a fresh fold. |
| **Hidden protocol** | A `tool_use`/`tool_result` whose row a card already surfaces; dropped by partition. |

## Contracts & invariants

- **Default-collapsed everywhere.** `Thinking` disclosures are closed by default
  whether streaming live or settled/reloaded. No `defaultOpen={reasoningStreaming}`.
- **Prose and artifacts never fold.** They are always on the visible list, so a
  later reasoning run cannot pull already-written prose behind a disclosure or
  remount it.
- **Process folds live and settled alike.** No settlement-time fold, no visible
  frontier. Partition reads block order/type only — never `isLive`, partial-block
  shape, or stream buffers.
- **Hidden protocol is dropped, not folded.** `isToolViewVisible` is the single
  predicate shared by partition, row rendering, and the digest.
- **Block render keys are positional.** `blockRenderKey` derives from
  `(turnId, sequence)`, never `block.id`. Text and artifact items keep DOM
  identity across streaming; a process item is keyed by its first block.

### What breaks if violated

- Folding prose → the writer's manuscript disappears mid-stream and remounts.
- Keying the partition off transient streaming state → the first frame and reload
  can disagree.
- Folding a resolved interrupt card → the user loses sight of what they acted on.
- Keying by `block.id` → ordinary updates can remount DOM nodes, losing animation
  continuity and scroll position.

## Architecture

```mermaid
flowchart TD
    Blocks[Turn.blocks: Block[]] --> Sort[sort by sequence]
    Sort --> Walk["partitionTurn (ordered walk)"]
    Walk --> Proc["process item: contiguous reasoning + process tools"]
    Walk --> Txt["text item: prose"]
    Walk --> Art["artifact item: custom card, image, file"]
    Proc --> Fold["ProcessDisclosure (collapsed, digest)"]
    Txt --> Vis["DeliveryBlock → Markdown / StreamingText"]
    Art --> Vis2["DeliveryBlock → CustomBlockRenderer / ImageBlock"]
```

Current code path:

```
AssistantTurn.tsx
  → partitionTurn(sortedBlocks)            ← ordered RenderItem[]
  → TurnItemView
      → process  → ProcessDisclosure(label, children)
                     → FoldRun              ← reasoning via TurnBlockStep
                     → DeliverySegments     ← activity tools via ToolRow
      → text/artifact → DeliveryBlock
                          → Markdown | StreamingText | CustomBlockRenderer | ImageBlock
```

`tool-renderers.tsx` is the registry for tool-name-specific presentation. Registry
keys must be real runtime tool names from
`apps/server/server/domains/runtime/tools/`. The current runtime surface is
`write`, `work`, `ls`, `search`, `ask_user`, `spawn`, and `return_result`.
`ask_user`, `spawn`, and `return_result` render through custom cards
(`choice`/`form`/`free-text`, `helper-result` → `SpawnReportCard`, and
`child-report` → `ChildReportBlock`), all built on the shared `ArtifactCard` shell
(`icon`/`tone`/`title`/`door`/`hint`/children). Their tool rows are hidden.
Process tools (`write`, `work`, `ls`, `search`) render as `ActivityRow`.
`tool-kind.ts` names the split: an **artifact** result is writer-facing
(custom card, image) and never folds; a **process** tool is scaffolding.
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
| `AssistantTurn.tsx` | Top-level turn render; drives partition + item mounting |
| `partition-turn.ts` | Ordered walk from `Block[]` to `RenderItem[]` (process/text/artifact) |
| `tool-kind.ts` | `artifact` vs `process` tool kinds |
| `group-delivery-segments.ts` | Pairs adjacent tool protocol blocks into ToolViews, then emits single-tool or tool-run segments |
| `ProcessDisclosure.tsx` | Collapsible `Thinking` disclosure with sticky user-toggle state |
| `CustomBlockRenderer.tsx` | Renders `custom` blocks; interrupts pass through `onRespondToInterrupt` |
| `tool-renderers.tsx` | Tool renderer registry; unknown tools show name only, registered tools use `toolVerb()` for tense and may show curated expand content. Mismatched keys don't error — a renamed tool silently falls through to the bare-name default, so verify registry keys against the server tool names when either side changes |
| `AssistantTurn.tsx` (`DeliverySegments`) | Renders adjacent ToolViews as sibling `ToolRow`s inside a fold |
| `ActivityRow.tsx` | Timeline row primitive: 19px icon gutter where each row paints its own 1px rail segment (no sibling-aware CSS). The rail invariants live in its header comment |
| `TurnBlockStep.tsx` | Compact label/body row for reasoning blocks inside a fold; text and artifacts are handled upstream |
| `block-render-key.ts` | Positional render keys — `turnId::sequence` |
| `block-kind.ts` | Block type predicates (`isToolDeliveryBlock`, `isImageBlock`) |
| `@meridian/contracts` → `threads/index.ts` | `Block`, `BlockType`, `Turn` types |

### Block types (`BlockType` from `@meridian/contracts`)

| BlockType | Tier | Rendered by |
|---|---|---|
| `reasoning`, `thinking` | process (reasoning run) | `TurnBlockStep` inside the fold |
| `text` | text | `Markdown` (settled) / `StreamingText` (partial) |
| `tool_use`, `tool_result` | process (activity run) | Paired into ToolViews by `groupDeliverySegments`, then sibling `ToolRow`s; dropped when hidden |
| `image` | artifact | `ImageBlock` |
| `file` | artifact | `TurnBlockStep` fallback |
| `custom` | artifact | `CustomBlockRenderer` → component registry |

## Implementation status

Implemented in `partition-turn.ts`, `ProcessDisclosure.tsx`, and
`AssistantTurn.tsx`. The partition returns an ordered `RenderItem[]`:
`process` items carry their ordered reasoning/activity runs, `text` and
`artifact` items carry their block. `ProcessDisclosure` is a default-collapsed
shell; process items compose reasoning rows and folded activity runs.
