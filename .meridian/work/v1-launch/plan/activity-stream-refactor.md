# Activity Stream Item Rendering Refactor

## Problem

The ActivityBlock component has three structural issues:

1. **Fragile alignment.** Detail content (expanded tool output, thinking text) is rendered as a sibling of the item header with manually coordinated `pl-9` padding. This value is derived from ItemLine's internal layout (`px-3` padding + `size-3.5` icon + `gap-2`), but nothing enforces synchronization. Changing ItemLine's icon size or gap silently breaks alignment.

2. **SRP violation in ActivityBlock.** ActivityBlock renders all three item kinds (`thinking`, `text`, `tool`) inline via if/else chains, manages per-item expand state, handles tool truncation ("N earlier tools..."), AND places detail content with coordinated padding. Too many concerns in one component.

3. **Prop drilling for agent nesting.** `depth` and `renderNestedActivity` are passed through `ToolRow → ToolDetail → AgentDetail` even though only `AgentDetail` uses them. Every component in the chain carries props it doesn't need, leaking the nesting concern into unrelated components (ISP violation).

## Design

### 1. Grid-based ItemLine with `detail` slot

Switch ItemLine from `flex` to `grid-cols-[auto_1fr_auto]`. The toggle button spans columns 1-2 (icon + label), actions occupy column 3. Detail content renders at columns 2-3, automatically aligned with the label text (past the icon) — no padding math.

```
grid-cols-[auto_1fr_auto]
     icon  label                    actions
     ─────┬────────────────────────┬────────
     [Button: icon + label text  ] │ [> badges]    <- row 1
           │ [detail content.....  ...........]    <- row 2 (col 2-3)
```

New prop: `detail?: ReactNode`. Renders below the header row starting at column 2, aligned with label text. When absent, layout is identical to current (single-row grid).

The `children` prop continues to serve as the right-side actions slot (badges, buttons).

#### Internal structure

```tsx
<div className={cn("grid grid-cols-[auto_1fr_auto] px-3", className)}>
  {/* Row 1, Col 1-2: Toggle button — spans icon + label columns */}
  <Button
    variant="ghost"
    onClick={onToggle}
    aria-expanded={expanded}
    aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
    className="col-span-2 flex min-h-10 min-w-0 items-center gap-2 rounded-none px-0 py-2 text-sm font-normal hover:bg-transparent hover:opacity-70"
  >
    <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span className={cn("truncate text-foreground", labelClassName)}>{label}</span>
  </Button>

  {/* Row 1, Col 3: Actions + caret */}
  <span className="flex min-h-10 items-center gap-2 py-2">
    {children}
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      tabIndex={-1}
      aria-hidden="true"
      className="size-5 rounded-none text-muted-foreground hover:text-foreground"
    >
      {expanded ? <CaretDown className="size-3.5" /> : <CaretRight className="size-3.5" />}
    </Button>
  </span>

  {/* Row 2, Col 2-3: Detail — starts after icon column, aligned with label text */}
  {detail ? <div className="col-start-2 col-span-2 pb-2">{detail}</div> : null}
</div>
```

Key details:
- **Icon stays inside the toggle Button** (col-span-2) — preserves click target, keyboard focus, `aria-expanded`, and dynamic `aria-label`. No interaction regression from current flex layout.
- **3-column grid** (`auto_1fr_auto`): col 1 is icon width (auto-sized inside the button), col 2 is label (1fr), col 3 is actions. Detail at `col-start-2 col-span-2` starts past the icon, aligned with label text.
- **`min-w-0`** on the button enables truncation of long labels (grid items don't zero min-size automatically).
- **Caret button** preserves `tabIndex={-1}` and `aria-hidden="true"` — redundant visual affordance only, not a separate tab stop.
- When detail is absent, renders identically to current — single-row grid, no empty row 2.

#### Props changes

```tsx
type ItemLineProps = {
  icon: ComponentType<{ className?: string }>
  label: string
  labelClassName?: string
  expanded?: boolean         // optional — text items aren't expandable
  onToggle?: () => void      // optional — no caret rendered when absent
  children?: ReactNode       // right-side actions slot (badges, buttons)
  detail?: ReactNode         // NEW — expanded content, grid-aligned
  className?: string
}
```

Making `expanded` and `onToggle` optional allows TextRow to potentially use ItemLine for layout consistency without needing toggle behavior, though TextRow may also just render plain markup if it doesn't need the icon column.

### 2. Nesting context

Create `activity-context.ts` with a React context for agent nesting:

```tsx
type ActivityNesting = {
  depth: number
  renderNestedActivity: (activity: ActivityBlockData, depth: number) => ReactNode
}

const ActivityNestingContext = createContext<ActivityNesting | null>(null)

export function ActivityNestingProvider({ depth, children }: { depth: number; children: ReactNode }) {
  const renderNestedActivity = useCallback(
    (nested: ActivityBlockData, nestedDepth: number) => (
      <ActivityBlock activity={nested} depth={nestedDepth} defaultExpanded={nestedDepth <= 1} showPendingText />
    ),
    []
  )

  return (
    <ActivityNestingContext.Provider value={{ depth, renderNestedActivity }}>
      {children}
    </ActivityNestingContext.Provider>
  )
}

export function useActivityNesting() {
  const ctx = useContext(ActivityNestingContext)
  if (!ctx) throw new Error("useActivityNesting must be used within an ActivityBlock")
  return ctx
}
```

**Important:** The `renderNestedActivity` callback is defined inside `ActivityNestingProvider`, which lives in `activity-context.ts`. This file imports `ActivityBlock` — creating a module-level circular dependency: `ActivityBlock → activity-context → ActivityBlock`.

**Breaking the cycle:** Use a lazy import inside the provider callback:

```tsx
// activity-context.ts
export function ActivityNestingProvider({ depth, children }: { depth: number; children: ReactNode }) {
  const renderNestedActivity = useCallback(
    (nested: ActivityBlockData, nestedDepth: number) => {
      // Lazy require to break circular dependency
      const { ActivityBlock } = require("./ActivityBlock")
      return <ActivityBlock activity={nested} depth={nestedDepth} defaultExpanded={nestedDepth <= 1} showPendingText />
    },
    []
  )
  // ...
}
```

**Alternative (cleaner):** Keep `renderNestedActivity` definition in ActivityBlock and pass it as a prop to the provider. The provider just stores/provides it — no import of ActivityBlock needed:

```tsx
// activity-context.ts — no ActivityBlock import
export function ActivityNestingProvider({
  depth,
  renderNestedActivity,
  children,
}: {
  depth: number
  renderNestedActivity: (activity: ActivityBlockData, depth: number) => ReactNode
  children: ReactNode
}) {
  const value = useMemo(() => ({ depth, renderNestedActivity }), [depth, renderNestedActivity])
  return (
    <ActivityNestingContext.Provider value={value}>
      {children}
    </ActivityNestingContext.Provider>
  )
}

// ActivityBlock.tsx — defines the callback, passes to provider
const renderNestedActivity = useCallback(
  (nested: ActivityBlockData, nestedDepth: number) => (
    <ActivityBlock activity={nested} depth={nestedDepth} defaultExpanded={nestedDepth <= 1} showPendingText />
  ),
  []
)

return (
  <ActivityNestingProvider depth={depth} renderNestedActivity={renderNestedActivity}>
    ...
  </ActivityNestingProvider>
)
```

This is the preferred approach — no circular imports, no lazy loading hacks. The provider is a dumb value holder.

**Nesting correctness:** Each nested ActivityBlock provides its OWN context with incremented depth. A depth-0 block provides `depth: 0`, so its AgentDetail calls `renderNestedActivity(activity, 1)`, which creates a depth-1 ActivityBlock that provides `depth: 1`, and so on. Context scoping (nearest provider wins) makes this work automatically.

### 3. Extract item renderers

Each item kind gets its own renderer component in an `items/` subdirectory:

#### `items/ThinkingRow.tsx`

```tsx
import { Brain } from "@phosphor-icons/react"
import { ItemLine } from "../ItemLine"
import type { ThinkingItem } from "../types"

type ThinkingRowProps = {
  item: ThinkingItem
  expanded: boolean
  onToggle: () => void
}

export function ThinkingRow({ item, expanded, onToggle }: ThinkingRowProps) {
  return (
    <ItemLine
      icon={Brain}
      label="Thinking"
      labelClassName="italic text-muted-foreground"
      expanded={expanded}
      onToggle={onToggle}
      detail={
        expanded ? (
          <p className="whitespace-pre-line text-sm italic text-muted-foreground">
            {item.text}
          </p>
        ) : undefined
      }
    />
  )
}
```

#### `items/TextRow.tsx`

Text items are not collapsible. They're inline content blocks. They don't use ItemLine — they're just a styled paragraph.

```tsx
import type { TextItem } from "../types"

type TextRowProps = {
  item: TextItem
}

export function TextRow({ item }: TextRowProps) {
  return (
    <div className="px-3 py-2">
      <p className="text-sm text-foreground">{item.text}</p>
    </div>
  )
}
```

Note: TextRow could use ItemLine if we wanted visual consistency (e.g., a text icon in column 1). But text items are inline content, not interactive rows, so plain markup is more appropriate. If the design evolves to want icon alignment for text items, switching to ItemLine is trivial.

#### `items/ToolRow.tsx`

Absorbs `ToolLine.tsx`. Renders ItemLine with status badges as `children` and ToolDetail as `detail`.

```tsx
import { ArrowSquareOut, Check, CircleNotch, X } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { ItemLine } from "../ItemLine"
import { ToolDetail } from "../ToolDetail"
import {
  getToolCategory,
  getToolIcon,
  getToolLineTitle,
  getToolStatusLabel,
  getToolStatusVariant,
} from "../tool-utils"
import type { ToolItem } from "../types"

type ToolRowProps = {
  tool: ToolItem
  expanded: boolean
  onToggle: () => void
  onViewFile?: () => void
  className?: string
}

function ToolStatusGlyph({ status }: Pick<ToolItem, "status">) {
  if (status === "done") return <Check className="size-3" aria-hidden="true" />
  if (status === "error") return <X className="size-3" aria-hidden="true" />
  return (
    <CircleNotch
      className={cn("size-3", status === "running" ? "animate-spin" : undefined)}
      aria-hidden="true"
    />
  )
}

export function ToolRow({ tool, expanded, onToggle, onViewFile, className }: ToolRowProps) {
  const category = getToolCategory(tool)
  const Icon = getToolIcon(category)
  const title = getToolLineTitle(tool)
  const statusText = getToolStatusLabel(tool.status)
  const statusVariant = getToolStatusVariant(tool.status)
  const showViewFile = category === "read" && tool.status === "done"

  return (
    <ItemLine
      icon={Icon}
      label={title}
      expanded={expanded}
      onToggle={onToggle}
      className={className}
      detail={expanded ? <ToolDetail tool={tool} /> : undefined}
    >
      {showViewFile ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            onViewFile?.()
          }}
          aria-label={`View file ${title}`}
          className="h-auto gap-1 rounded-none px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          <ArrowSquareOut className="size-3" aria-hidden="true" />
          View file
        </Button>
      ) : null}
      <Badge variant={statusVariant} className="h-5 px-2 text-[11px] font-medium">
        <ToolStatusGlyph status={tool.status} />
        {statusText}
      </Badge>
    </ItemLine>
  )
}
```

### 4. Simplify ToolDetail

Remove `depth`, `renderNestedActivity`, and `className` props. ToolDetail no longer needs to thread nesting props — AgentDetail reads them from context. The wrapper `<div className={className}>` disappears since the detail is now rendered inside ItemLine's grid-aligned detail slot.

```tsx
type ToolDetailProps = {
  tool: ToolItem
}

export function ToolDetail({ tool }: ToolDetailProps) {
  if (tool.detail?.kind === "read") return <ReadDetail detail={tool.detail} />
  if (tool.detail?.kind === "edit") return <EditDetail detail={tool.detail} />
  if (tool.detail?.kind === "doc-search") return <DocSearchDetail detail={tool.detail} />
  if (tool.detail?.kind === "web-search") return <WebSearchDetail detail={tool.detail} />
  if (tool.detail?.kind === "bash") return <BashDetail detail={tool.detail} />
  if (tool.detail?.kind === "agent") return <AgentDetail detail={tool.detail} />

  // Fallback: show raw args
  return (
    <Card variant="outline" className="gap-0 rounded-md border-border/70 py-0">
      <CardContent className="space-y-2 p-3">
        <pre className="overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-muted-foreground">
          {JSON.stringify(tool.args ?? {}, null, 2)}
        </pre>
      </CardContent>
    </Card>
  )
}
```

### 5. Simplify AgentDetail

Remove `depth` and `renderNestedActivity` props. Read from context instead.

```tsx
type AgentDetailProps = {
  detail: AgentToolDetail
}

export function AgentDetail({ detail }: AgentDetailProps) {
  const { depth, renderNestedActivity } = useActivityNesting()
  const { agent } = detail

  return (
    <Card variant="outline" className="gap-0 rounded-md border-border/70 border-l-2 border-l-accent-fill bg-card/90 py-0">
      <CardContent className="space-y-3 p-3">
        <div className="flex items-center gap-2 text-sm">
          <Robot className="size-4 text-muted-foreground" aria-hidden="true" />
          <p className="font-medium text-foreground">Agent: {agent.name}</p>
        </div>
        {renderNestedActivity(agent.activity, depth + 1)}
        {agent.response ? (
          <>
            <Separator />
            <p className="font-editor text-sm leading-relaxed text-foreground">{agent.response}</p>
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
```

### 6. Simplify ActivityBlock render loop

Replace inline if/else rendering with imports of the three row components:

```tsx
import { ThinkingRow } from "./items/ThinkingRow"
import { TextRow } from "./items/TextRow"
import { ToolRow } from "./items/ToolRow"
import { ActivityNestingProvider } from "./activity-context"

// In render:
return (
  <ActivityNestingProvider depth={depth} renderNestedActivity={renderNestedActivity}>
    <div className={cn("space-y-2", depth > 0 ? "ml-4" : undefined, className)}>
      <Collapsible ...>
        <Card ...>
          <ActivityBlockHeader ... />
          <CollapsibleContent>
            {/* truncation pill — unchanged */}
            <div className="relative">
              <div className="pointer-events-none absolute bottom-2 left-2 top-2 w-px bg-foreground/10" />
              {visibleItems.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">No activity yet.</p>
              ) : (
                visibleItems.map((item) => {
                  if (item.kind === "text") {
                    return <TextRow key={item.id} item={item} />
                  }

                  const isExpanded = expandedTools.has(item.id)
                  const toggle = () => toggleExpanded(item.id)

                  if (item.kind === "thinking") {
                    return <ThinkingRow key={item.id} item={item} expanded={isExpanded} onToggle={toggle} />
                  }

                  return <ToolRow key={item.id} tool={item} expanded={isExpanded} onToggle={toggle} />
                })
              )}
            </div>
          </CollapsibleContent>
        </Card>
      </Collapsible>
      {/* pending text — unchanged */}
    </div>
  </ActivityNestingProvider>
)
```

The `renderNestedActivity` callback is defined inside ActivityBlock as a `useCallback`:

```tsx
const renderNestedActivity = useCallback(
  (nested: ActivityBlockData, nestedDepth: number) => (
    <ActivityBlock
      activity={nested}
      depth={nestedDepth}
      defaultExpanded={nestedDepth <= 1}
      showPendingText
      className="mt-2"
    />
  ),
  []
)
```

### 7. Update barrel export

Remove `ToolLine` export, add row component exports if needed externally:

```tsx
// index.ts — remove:
export { ToolLine } from "./ToolLine"

// Keep all other exports. The row components (ThinkingRow, TextRow, ToolRow)
// are internal to ActivityBlock and don't need to be exported unless
// consumers need them directly.
```

## File changes

| File | Action | Notes |
|------|--------|-------|
| `activity-context.ts` | **New** | Nesting context provider + hook |
| `ItemLine.tsx` | **Refactor** | flex → grid, add `detail` prop, make `expanded`/`onToggle` optional |
| `items/ThinkingRow.tsx` | **New** | Thinking renderer using ItemLine |
| `items/TextRow.tsx` | **New** | Text renderer (plain markup) |
| `items/ToolRow.tsx` | **New** | Tool renderer, absorbs ToolLine + ToolStatusGlyph |
| `ActivityBlock.tsx` | **Simplify** | Provides context, delegates to row components, drops inline rendering |
| `ToolDetail.tsx` | **Simplify** | Remove `depth`, `renderNestedActivity`, `className` props |
| `AgentDetail.tsx` | **Simplify** | Remove props, read nesting from context |
| `ToolLine.tsx` | **Delete** | Absorbed into ToolRow |
| `index.ts` | **Update** | Remove ToolLine export |
| `ActivityBlock.stories.tsx` | **No change** | Stories use ActivityBlock public API — internal refactor is transparent |

## Verification

1. `pnpm run build` — no type errors
2. `pnpm run lint` — no lint warnings
3. Storybook visual verification — all existing ActivityBlock stories render identically:
   - `CompletedTurn` — collapsed block with response text
   - `Streaming` — interleaved thinking/text/tools with mixed statuses
   - `AllToolDetails` — all tool types expanded with truncation pill
   - `EditReviewStates` — pending/accepted/rejected edit details
   - `AgentSpawn` — nested agent with sub-activity (critical for nesting context)
4. Expanded detail content aligns with label text (the original bug)
5. Agent nesting works at depth 2+ (AgentSpawn story, manually test deeper nesting)

## Streaming compatibility

### Current state

Frontend v2 is UI-first with no data layer connected yet (Phase 7). `ActivityBlockData` is passed as static props in Storybook stories. The `isStreaming` flag and `items` array are just data — the component is a pure renderer with no transport awareness.

### Future data flow

```
SSE/WebSocket → AG-UI events → state store → ActivityBlockData → ActivityBlock
```

The backend uses the AG-UI protocol (transport-agnostic). Events arrive as:
- `TEXT_MESSAGE_CONTENT` deltas → store accumulates into `TextItem.text` or `pendingText`
- `TOOL_CALL_START/ARGS/END` → store creates/updates `ToolItem` entries
- `THINKING_*` events → store creates/updates `ThinkingItem` entries

The store rebuilds the `items` array and React re-renders ActivityBlock. Components never interact with the transport directly.

### Why this refactor is streaming-compatible

1. **No data model changes.** `ActivityBlockData`, `ActivityItem`, and all subtypes are untouched. The store-to-component contract is preserved.

2. **Items have stable IDs.** React reconciliation handles list growth efficiently during streaming (new items appended, existing items updated in place).

3. **Context is a readability win, not a render isolation win.** The `ActivityNestingProvider` removes prop drilling (ISP improvement), but does NOT prevent subtree re-renders during streaming. Even with `useMemo` on the context value, the provider receives fresh `children` on every parent render, so React still reconciles the full subtree. This is acceptable — the current code has the same re-render behavior. If streaming perf becomes an issue, the path is `React.memo` on row components with stable keys, not context memoization.

4. **Concurrent agent streams.** Nested agents can have their own SSE/WebSocket connections. Each nested `ActivityBlockData` has its own `isStreaming` flag. The nesting context handles this — each `ActivityBlock` instance is independent with its own provider.

5. **Transport migration (SSE → WebSocket).** Irrelevant to the component layer. `ActivityBlockData` is the contract. Whether events arrive via SSE, WebSocket, or polling doesn't affect rendering.

### Streamdown integration (future)

The v1 frontend uses `streamdown` for incremental markdown rendering of text and thinking blocks. When v2 integrates data (Phase 7):

- `TextRow` would switch from `<p>{item.text}</p>` to `<Streamdown content={item.text} isStreaming={...} />`
- `ThinkingRow` would do the same for thinking content
- This is a rendering concern **inside** the row components. The refactor doesn't block or constrain this — each row component controls its own rendering.

The grid layout in ItemLine is transparent to streamdown. The `detail` slot receives whatever ReactNode the row component provides. Swapping `<p>` for `<Streamdown>` is a one-line change per row component.

### Multiple streaming sources

The AG-UI protocol supports multiple concurrent tool calls and text interleaving. The store handles sequencing — it produces a single `items` array in display order. The component doesn't need to know about multiplexing.

For parallel agent spawns (multiple nested ActivityBlocks streaming simultaneously), each agent's `ActivityBlockData` is independent with its own `isStreaming` flag. The nesting context ensures each nested block gets the correct depth without interference.

## Non-goals

- No OCP registry pattern for item kinds (3 kinds, unlikely to grow rapidly, if/else is readable and type-safe)
- No OCP registry for ToolDetail kinds (same reasoning)
- No changes to detail renderers (ReadDetail, EditDetail, BashDetail, etc.) — they're fine
- No changes to types, tool-utils, or ActivityBlockHeader
- No visual changes — this is a pure structural refactor
- No streamdown integration — Phase 7 concern, refactor doesn't block it

## V1 patterns to consider

The v1 frontend (`frontend/src/features/threads/`) has battle-tested patterns that this refactor should be aware of. Some are directly relevant, others are data-layer concerns for Phase 7.

### Relevant to this refactor

1. **`React.memo` on block components.** V1 uses `React.memo` on AssistantTurn and all block components. This reduces re-render fan-out but does NOT eliminate it for the actively streaming item. During streaming, the last item's props change every delta tick — memo doesn't help there. Memo only helps the N-1 completed items above it (stable props, skipped re-renders). This is still valuable when there are many completed items. **Caveat:** this only works if the store preserves object references for unchanged items. If the store rebuilds all item objects on each tick, memo is useless. The row components should be wrapped in `React.memo`, but the real streaming performance lever is in the store layer (Phase 7) — preserving referential stability for completed items.

2. **Block type registry.** V1 uses `registry.ts` to map blockType → component and `toolRegistry.ts` to map toolName → custom UI. Our plan uses if/else dispatch for 3 item kinds, which is fine at this scale. But note that v1 learned to use registries as tool types grew. If v2 adds more item kinds, migrate to a registry.

3. **Stable React keys.** V1 has `blockIdentity.ts` that generates stable keys across `refreshTurn()` calls — using `tool_use_id` for tool blocks and `sequence` for others. This prevents `<details>` elements from collapsing, Streamdown content resetting, and scroll jumps on refresh. **The current plan uses `item.id` as keys, which should be stable, but this needs to be validated when the store layer is built.**

4. **Three-pass block grouping.** V1 groups blocks before rendering: (1) pair tool_use + tool_result, (2) group thinking + nested tools, (3) group standalone tools. ActivityBlock currently renders items flat. This is acceptable for now since the `ActivityBlockData.items` array is pre-organized by the data source, but note that v1 found grouping essential for UX — especially for thinking blocks that contain nested tool calls. If ActivityBlock eventually receives raw AG-UI events, it will need similar grouping logic.

### V1 pain points to improve upon

5. **Text fragmentation.** V1's biggest known UX issue. When models interleave short text between tools ("Let me check..." → tool → "Now I'll update..." → tool), the 3-pass grouping algorithm breaks groups and creates clunky interleaved output. V1 already has a design doc (`activity-stream-design.md`) proposing "pending text absorption" where intermediate text blocks are absorbed into the activity group, and only the final text block becomes the substantive response. **V2's ActivityBlock already models this correctly** — `ActivityBlockData.items` contains interleaved text/thinking/tool items as a flat list within one block, and `pendingText` is the final response shown below the card. The refactor should preserve this model rather than adopting v1's 3-pass splitting.

6. **Inconsistent collapsible patterns.** V1 uses native HTML `<details>` for single thinking blocks but Radix `Collapsible` for ThinkingGroupBlock. V2 should use the design system collapsible consistently. Our refactor handles this — ItemLine owns the expand/collapse toggle for all item types.

7. **ToolInteractionBlock complexity.** V1's single component (294 lines) handles title construction, tool meta extraction, status determination, animation state, and error messages. V2's split into ToolRow (header + status) + ToolDetail (expanded content) + per-kind detail renderers is already an improvement. The refactor preserves this separation.

8. **Collapsible state scope.** V1 uses a global `useUIStore` for expanded group state (session-scoped, cleared on thread switch). V2 uses local `useState(new Set())` inside ActivityBlock. Local state is simpler and self-contained, but won't survive component unmount/remount (e.g., thread switching). For now local state is fine since v2 has no data layer. When Phase 7 connects the store, consider whether expanded state needs to survive thread switches.

### Data-layer patterns (Phase 7, not this refactor)

5. **Separate tool streaming store.** V1 keeps progressive tool UI state (`useToolStreamStore`: active arg key, preview, bytes received) separate from persisted turn data (`useThreadStore`). This allows tool UI to stay responsive while text blocks update independently.

6. **Streaming buffer with 50ms batching.** V1's `useStreamingBuffer` batches text deltas (potentially 1000/sec) into 50ms flush intervals, reducing React re-renders ~50x. Critical for performance but lives in the data/hook layer, not components.

7. **Tool args metadata tracking.** V1 uses `ToolArgsStreamTracker` to scan JSON deltas incrementally — extracting active arg key, preview head/tail, and byte count — without waiting for full JSON parse. Keeps tool call UI responsive even for huge arguments (64KB cap with truncation flag).

## Deferred items (from review)

1. **TextRow using ItemLine.** Text items don't use the shared row shell. If cross-cutting row features (drag-drop, selection) are needed later, TextRow can adopt ItemLine. Design decision — defer until needed.

2. **`EditToolDetail` callbacks.** `onAccept`/`onReject`/`onReviewInEditor` embedded in the data type. Phase 7 store integration should inject UI actions separately from serializable data.
