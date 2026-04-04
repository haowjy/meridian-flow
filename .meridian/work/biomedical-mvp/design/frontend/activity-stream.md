# Activity Stream — Two-Zone Model

Redesigned ActivityBlock for the biomedical MVP. One block per assistant turn. Two rendering zones: collapsed (details) and visible (content). Per-tool-category display config determines what goes where. See [overview](overview.md) for frontend architecture context.

## The Model

```
+-----------------------------------------------------+
| ActivityBlock (one per assistant turn)               |
|                                                     |
| -- Collapsed Zone (expand to see) ----------------  |
| | ThinkingRow: "I need to load the DICOM stack..." | |
| | ToolRow: python                                  | |
| |   input: import SimpleITK as sitk...  (collapsed)| |
| | ToolRow: bash                                    | |
| |   input: pip install vtk             (collapsed) | |
| |   stdout: Collecting vtk...          (collapsed) | |
| +--------------------------------------------------+ |
|                                                     |
| -- Visible Zone (always shown) -------------------  |
| "I'll segment the knee joint bones..."               |
|                                                     |
| python stdout:                                       |
|   Loading DICOM stack...                             |
|   Processing slice 342/342...                        |
|   Found 5 regions                                    |
|                                                     |
| [Plotly chart: Bone Volume Distribution]             |
|                                                     |
| [Table: Scan Metadata (5x3)]                         |
|                                                     |
| [Mesh Card: Femur - 45,000 vertices] [View 3D]      |
| [Mesh Card: Tibia - 38,000 vertices] [View 3D]      |
|                                                     |
| "Segmentation complete. I identified 5 regions..."   |
+-----------------------------------------------------+
```

**Key principle**: The visible zone contains everything the researcher needs — text, images, charts, tables, mesh cards, and stdout from tools that default to uncollapsed output. The collapsed zone contains implementation details (thinking, tool inputs, stdout from tools that collapse by default). Results are inline content, interleaved with text.

## Per-Tool-Category Display Config

Each tool category defines default collapse behavior for its input, stdout, and stderr. This is extensible — new tool categories register their own defaults.

```typescript
// features/activity-stream/tool-display-config.ts

export interface ToolDisplayConfig {
  input: "collapsed" | "visible"
  stdout: "collapsed" | "visible"
  stderr: "hidden"  // Always hidden — click for popup
}

export const TOOL_DISPLAY_CONFIG: Record<string, ToolDisplayConfig> = {
  python: {
    input: "collapsed",     // Code goes in collapsed zone
    stdout: "visible",      // Output shows in visible zone
    stderr: "hidden",       // Click for popup
  },
  bash: {
    input: "collapsed",     // Command goes in collapsed zone
    stdout: "collapsed",    // Output in collapsed zone
    stderr: "hidden",       // Click for popup
  },
  read: {
    input: "collapsed",
    stdout: "collapsed",
    stderr: "hidden",
  },
  edit: {
    input: "collapsed",
    stdout: "collapsed",
    stderr: "hidden",
  },
}

export function getToolDisplayConfig(category: string): ToolDisplayConfig {
  return TOOL_DISPLAY_CONFIG[category] ?? {
    input: "collapsed",
    stdout: "collapsed",
    stderr: "hidden",
  }
}
```

### stderr Handling

stderr is always hidden by default. It's usually noise (deprecation warnings, progress bars, library chatter). When there IS an error, the tool result shows the failure — stderr is available for debugging but doesn't clutter the output.

**Interaction**: A small icon/badge appears on the tool row when stderr exists. Clicking it opens a popup/modal with the stderr content. Not inline, not collapsed — a separate interaction.

```tsx
// In ToolRow — stderr popup trigger
{tool.toolOutput?.some(l => l.stream === "stderr") && (
  <StderrPopover lines={tool.toolOutput.filter(l => l.stream === "stderr")}>
    <button className="text-xs text-muted-foreground hover:text-destructive">
      <WarningCircle className="h-3.5 w-3.5" />
    </button>
  </StderrPopover>
)}
```

## New Event Types

Add to the `StreamEvent` union in `src/features/activity-stream/streaming/events.ts`:

```typescript
export type StreamEvent =
  // ... existing events ...
  // Tool execution streaming (Meridian extension)
  | {
      type: "TOOL_OUTPUT"
      toolCallId: string
      stream: "stdout" | "stderr"
      text: string
      sequence: number
    }
  // Display result — inline content from any tool
  | {
      type: "DISPLAY_RESULT"
      toolCallId: string
      resultType: "plotly" | "image" | "dataframe" | "mesh_ref"
      data: DisplayResultPayload
    }
```

Add `"TOOL_OUTPUT"` and `"DISPLAY_RESULT"` to the `STREAM_EVENT_TYPES` array.

## New Activity Types

Add to `src/features/activity-stream/types.ts`:

```typescript
/** Accumulated stdout/stderr line from tool execution. Stored on ToolItem. */
export type ToolOutputLine = {
  stream: "stdout" | "stderr"
  text: string
  sequence: number
}

/** Rich result payload from any tool. */
export type DisplayResultPayload =
  | { resultType: "plotly"; plotly_json: object }
  | { resultType: "image"; base64: string; format: string }
  | { resultType: "dataframe"; html: string; title?: string; row_count: number; col_count: number }
  | { resultType: "mesh_ref"; mesh_id: string; vertex_count: number; face_count: number; label: string; color: string }

/**
 * Rich display result. Renders inline in the visible zone of the ActivityBlock,
 * interleaved with text content. Not specific to any tool.
 */
export type DisplayResultItem = {
  kind: "display-result"
  id: string               // `${toolCallId}-result-${sequence}`
  toolCallId: string       // Links back to the ToolItem that produced it
  data: DisplayResultPayload
}
```

Extend existing types:

```typescript
// Extended ToolItem — add toolOutput field
export type ToolItem = {
  // ... existing fields ...
  /** Accumulated stdout/stderr lines from TOOL_OUTPUT events. */
  toolOutput?: ToolOutputLine[]
}

// Extended ActivityItem union
export type ActivityItem = ThinkingItem | ContentItem | ToolItem | DisplayResultItem
```

**Change from previous design**: `mesh_ref` payload has `label: string` and `color: string` instead of `label_names: Record<string, string>`. Each mesh is a single named structure.

## Reducer Logic

Add cases to `reduceStreamEvent()` in `src/features/activity-stream/streaming/reducer.ts`:

```typescript
case "TOOL_OUTPUT": {
  const line: ToolOutputLine = {
    stream: event.stream,
    text: event.text,
    sequence: event.sequence,
  }
  const items = updateItemById<ToolItem>(
    state.activity.items,
    event.toolCallId,
    (item) => ({
      ...item,
      status: item.status === "streaming-args" ? "executing" : item.status,
      toolOutput: [...(item.toolOutput ?? []), line],
    })
  )
  return {
    ...state,
    activity: { ...state.activity, items },
  }
}

case "DISPLAY_RESULT": {
  const existingResults = state.activity.items.filter(
    (i) => i.kind === "display-result" && i.toolCallId === event.toolCallId
  )
  const resultItem: DisplayResultItem = {
    kind: "display-result",
    id: `${event.toolCallId}-result-${existingResults.length}`,
    toolCallId: event.toolCallId,
    data: event.data,
  }
  return {
    ...state,
    activity: {
      ...state.activity,
      items: [...state.activity.items, resultItem],
    },
  }
}
```

## Event Ordering

Events arrive in this order per tool call (per [backend display-results.md](../backend/display-results.md)):

```
TOOL_CALL_START (python or bash)
  TOOL_CALL_ARGS (code/command parameter, may be multiple deltas)
  TOOL_CALL_END (AG-UI protocol -- fires when args finish streaming, before execution)
  TOOL_OUTPUT (0..N, sequenced -- streaming during execution)
  DISPLAY_RESULT (0..N, after execution completes -- python tool only)
TOOL_CALL_RESULT (final status)
```

`TOOL_CALL_END` is generated by the AG-UI SSE library when the LLM finishes the tool_use block. The existing reducer already transitions tool status to `"executing"` on `TOOL_CALL_END`. `TOOL_OUTPUT` events arrive after this transition.

## ActivityBlock Rendering — Two Zones

### Item Separation

ActivityBlock separates items into two zones based on kind and tool display config:

```typescript
function useZoneSeparation(items: ActivityItem[]) {
  return useMemo(() => {
    const collapsed: ActivityItem[] = []
    const visible: Array<ActivityItem | DisplayResultItem> = []

    for (const item of items) {
      switch (item.kind) {
        case "thinking":
          // Always collapsed
          collapsed.push(item)
          break

        case "tool":
          // Tool row always goes in collapsed zone (shows input, status)
          collapsed.push(item)
          // But stdout may go in visible zone based on tool config
          // (handled by ToolOutputVisible component below)
          break

        case "display-result":
          // Always visible — inline content
          visible.push(item)
          break

        case "content":
          // Text content always visible
          visible.push(item)
          break
      }
    }

    return { collapsed, visible }
  }, [items])
}
```

### Visible Zone: Tool stdout

For tools whose display config says `stdout: "visible"` (like `python`), the stdout appears in the visible zone even though the tool row itself is collapsed:

```tsx
function VisibleToolOutput({ tool }: { tool: ToolItem }) {
  const config = getToolDisplayConfig(getToolCategory(tool))
  if (config.stdout !== "visible") return null

  const stdoutLines = tool.toolOutput?.filter(l => l.stream === "stdout")
  if (!stdoutLines?.length) return null

  return <ToolOutputBlock lines={stdoutLines} isStreaming={tool.status === "executing"} />
}
```

### Render Structure

```tsx
function ActivityBlock({ activity }: Props) {
  const { collapsed, visible } = useZoneSeparation(activity.items)
  const hasCollapsed = collapsed.length > 0

  return (
    <div>
      {/* Collapsed zone — expand to see details */}
      {hasCollapsed && (
        <Card>
          <ActivityBlockHeader summary={getActivitySummary(activity)} />
          <CollapsibleContent>
            {collapsed.map(item => {
              if (item.kind === "thinking") return <ThinkingRow key={item.id} ... />
              if (item.kind === "tool") return <ToolRow key={item.id} ... />
              return null
            })}
          </CollapsibleContent>
        </Card>
      )}

      {/* Visible zone — always shown, interleaved content */}
      {visible.map(item => {
        if (item.kind === "content") {
          return <MarkdownContent key={item.id} text={item.text} />
        }
        if (item.kind === "display-result") {
          return <DisplayResultRow key={item.id} item={item} />
        }
        return null
      })}

      {/* Visible stdout for tools with uncollapsed output */}
      {activity.items
        .filter((i): i is ToolItem => i.kind === "tool")
        .map(tool => <VisibleToolOutput key={`${tool.id}-stdout`} tool={tool} />)
      }
    </div>
  )
}
```

**Note**: The exact interleaving of text, results, and stdout in the visible zone follows insertion order from the items array. Content, display results, and visible stdout all appear in the order they were received.

## ToolDetail Routing

The existing `getToolCategory()` in `tool-utils.ts` handles both tools:

```typescript
// "python" tool name -> segments ["python"] -> category "python" -> PythonDetail
// "bash" tool name -> segments ["bash"] -> matches -> category "bash" -> BashDetail
```

### PythonDetail (new)

Shows the Python code input when the tool row is expanded in the collapsed zone:

```typescript
function PythonDetail({ tool }: { tool: ToolItem }) {
  const code = readString(tool.parsedArgs, ["code"])

  return (
    <div className="space-y-2">
      {code && (
        <CodeBlock language="python" code={code} />
      )}
      {/* Stderr popup trigger */}
      <StderrBadge tool={tool} />
    </div>
  )
}
```

### BashDetail (extended)

Shows command + exit status + collapsed stdout when expanded:

```typescript
function BashDetail({ tool }: { tool: ToolItem }) {
  const command = readString(tool.parsedArgs, ["command", "cmd"])

  return (
    <div className="space-y-2">
      {command && <CodeBlock language="bash" code={command} />}
      {tool.toolOutput && tool.toolOutput.length > 0 && (
        <ToolOutputBlock
          lines={tool.toolOutput}
          isStreaming={tool.status === "executing"}
        />
      )}
      <StderrBadge tool={tool} />
    </div>
  )
}
```

## StderrPopover

Hidden by default, click to see in a popup. Not inline, not collapsed — separate interaction:

```tsx
function StderrPopover({ lines, children }: { lines: ToolOutputLine[]; children: React.ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="max-h-[300px] max-w-[600px] overflow-auto">
        <div className="font-mono text-xs">
          {lines.map(line => (
            <div key={line.sequence} className="whitespace-pre-wrap text-destructive">
              {line.text}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function StderrBadge({ tool }: { tool: ToolItem }) {
  const stderrLines = tool.toolOutput?.filter(l => l.stream === "stderr")
  if (!stderrLines?.length) return null

  return (
    <StderrPopover lines={stderrLines}>
      <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive">
        <WarningCircle className="h-3.5 w-3.5" />
        <span>{stderrLines.length} warnings</span>
      </button>
    </StderrPopover>
  )
}
```

## Tool Category Extensions

Add to `tool-utils.ts`:

```typescript
// In getToolCategory():
// "python" -> add python category detection
if (hasSegment(segments, ["python"])) return "python"

// In getToolSummary():
if (category === "python") {
  const code = readString(parsedArgs, ["code"])
  return code ? code.split('\n')[0] : undefined
}
if (category === "bash") {
  const cmd = readString(parsedArgs, ["command", "cmd"])
  return cmd ? cmd.split('\n')[0] : undefined
}

// In getActivitySummary():
if (counts.python > 0) {
  parts.push(`ran ${counts.python} ${pluralize(counts.python, "analysis", "analyses")}`)
}
if (counts.bash > 0) {
  parts.push(`ran ${counts.bash} ${pluralize(counts.bash, "command", "commands")}`)
}
```

## Persisted Turn Blocks

The backend persists `tool_output` and `display_result` as new `BlockType` values. On reload, the turn-mapper reconstructs activity from these blocks.

Add to `frontend-v2/src/features/threads/types.ts`:

```typescript
export type BlockType =
  | "text"
  | "thinking"
  | "tool_use"
  | "tool_result"
  | "image"
  | "reference"
  | "partial_reference"
  | "web_search_use"
  | "web_search_result"
  | "collapse_marker"
  | "tool_output"       // Persisted stdout/stderr
  | "display_result"    // Persisted rich result (chart, table, image, mesh_ref)
```

The `turn-mapper.ts` must map:
- `display_result` blocks into `DisplayResultItem` entries (visible zone)
- `tool_output` blocks into `ToolItem.toolOutput` arrays, applying the `tool_name` field to determine which tool category's display config governs visibility

## Storybook Testing

Add streaming scenarios to `src/features/activity-stream/examples/`:

```typescript
// examples/python-execution.ts
export const PYTHON_ANALYSIS_SCENARIO: StreamEvent[] = [
  { type: "RUN_STARTED" },
  // AI writes some text first
  { type: "TEXT_MESSAGE_START", messageId: "msg-001" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-001", delta: "I'll segment the knee joint..." },
  { type: "TEXT_MESSAGE_END", messageId: "msg-001" },
  // Python tool call
  { type: "TOOL_CALL_START", toolCallId: "py-001", toolCallName: "python" },
  { type: "TOOL_CALL_ARGS", toolCallId: "py-001", delta: '{"code":"import SimpleITK as sitk\\n..."}' },
  { type: "TOOL_CALL_END", toolCallId: "py-001" },
  // Stdout streams in visible zone (python stdout is uncollapsed)
  { type: "TOOL_OUTPUT", toolCallId: "py-001", stream: "stdout", text: "Loading DICOM stack...", sequence: 0 },
  { type: "TOOL_OUTPUT", toolCallId: "py-001", stream: "stdout", text: "Processing 200 slices...", sequence: 1 },
  // Display results appear inline
  { type: "DISPLAY_RESULT", toolCallId: "py-001", resultType: "dataframe", data: {
    resultType: "dataframe", html: "<table>...</table>", title: "Scan Metadata", row_count: 5, col_count: 3
  }},
  { type: "DISPLAY_RESULT", toolCallId: "py-001", resultType: "mesh_ref", data: {
    resultType: "mesh_ref", mesh_id: "femur", vertex_count: 45000, face_count: 90000,
    label: "Femur", color: "#4488ff"
  }},
  { type: "DISPLAY_RESULT", toolCallId: "py-001", resultType: "mesh_ref", data: {
    resultType: "mesh_ref", mesh_id: "tibia", vertex_count: 38000, face_count: 76000,
    label: "Tibia", color: "#44cc66"
  }},
  { type: "TOOL_CALL_RESULT", toolCallId: "py-001", content: '{"is_error":false}' },
  // Final response text
  { type: "TEXT_MESSAGE_START", messageId: "msg-002" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-002", delta: "Segmentation complete. I identified..." },
  { type: "TEXT_MESSAGE_END", messageId: "msg-002" },
  { type: "RUN_FINISHED" },
]
```

## Related Docs

- [Inline Results](inline-results.md) — DisplayResultRow and block renderer components
- [3D Viewer](viewer-3d.md) — MeshRefBlock triggers viewer via workspace store
- [State Management](state.md) — viewer store receives mesh data from binary frames
- [Display Result Pipeline (backend)](../backend/display-results.md) — event payload contracts
