# Activity Stream — Revised Model

Redesigned ActivityBlock model for the biomedical MVP. One block per assistant turn. All "work" collapses inside; display results and final response text render outside, always visible. See [overview](overview.md) for frontend architecture context.

**Replaces**: `activity-stream-extensions.md` which had Python-specific events (`PYTHON_OUTPUT`, `PYTHON_RESULT`). The new model uses generic events (`TOOL_OUTPUT`, `DISPLAY_RESULT`) that work for any tool.

## The Model

```
┌─────────────────────────────────────────────────┐
│ ActivityBlock (one per assistant turn)           │
│                                                 │
│ ┌─ Collapsible Card ─────────────────────────┐  │
│ │ ActivityBlockHeader                        │  │
│ │   "Ran 3 commands, processed 200 slices"   │  │
│ │ ┌─────────────────────────────────────────┐│  │
│ │ │ ThinkingRow (collapsed by default)      ││  │
│ │ │ ToolRow: bash "python3 load_data.py"    ││  │
│ │ │   └─ BashDetail: stdout, command, exit  ││  │
│ │ │ ContentRow: "Loading the DICOM stack..." ││  │
│ │ │ ToolRow: bash "python3 segment.py"      ││  │
│ │ │   └─ BashDetail: stdout, stderr         ││  │
│ │ └─────────────────────────────────────────┘│  │
│ └────────────────────────────────────────────┘  │
│                                                 │
│ ── Display Results (always visible) ──────────  │
│ ┌─────────────────────────────────────────────┐ │
│ │ DataFrameBlock: "Scan Metadata" (5 × 3)    │ │
│ └─────────────────────────────────────────────┘ │
│ ┌─────────────────────────────────────────────┐ │
│ │ MeshRefBlock: "3D Model Generated"          │ │
│ │ 45,000 vertices — femur, tibia, patella     │ │
│ │                            [View 3D]        │ │
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ ── Response Text (always visible) ────────────  │
│ "The segmentation is complete. I identified..."  │
└─────────────────────────────────────────────────┘
```

**Key principle**: The researcher sees results and the AI's response without expanding anything. The work details (tool calls, thinking, intermediate text) are available on expand for debugging or curiosity.

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
  // Display result — generic, any tool can emit
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
  | { resultType: "mesh_ref"; mesh_id: string; vertex_count: number; face_count: number; label_names?: Record<string, string> }

/**
 * Rich display result. Renders OUTSIDE the collapsed ActivityBlock card,
 * always visible. Not specific to any tool — any tool can emit these.
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
      // Transition to "executing" on first output if still streaming args
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
  // Create a new DisplayResultItem in the activity items array
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

Events arrive in this guaranteed order per tool call (per [backend display-results.md](../backend/display-results.md)):

```
TOOL_CALL_START (bash)
  TOOL_CALL_ARGS (command parameter, may be multiple deltas)
  TOOL_OUTPUT (0..N, sequenced — streaming during execution)
  DISPLAY_RESULT (0..N, after all TOOL_OUTPUT)
TOOL_CALL_END (after all output and display result events)
TOOL_CALL_RESULT (final status)
```

`TOOL_CALL_END` arrives AFTER all `TOOL_OUTPUT` and `DISPLAY_RESULT` events. The `TOOL_OUTPUT` handler transitions tool status to `"executing"` on first arrival.

## ActivityBlock Rendering

### Item Separation

ActivityBlock separates items into three groups:

```typescript
const { blockItems, displayResults, responseText } = useMemo(() => {
  const results: DisplayResultItem[] = []
  const nonResults: ActivityItem[] = []

  for (const item of activity.items) {
    if (item.kind === "display-result") {
      results.push(item)
    } else {
      nonResults.push(item)
    }
  }

  // Last ContentItem becomes response text (existing pattern)
  let lastContentItem: ActivityItem | undefined
  for (let i = nonResults.length - 1; i >= 0; i--) {
    if (nonResults[i].kind === "content") {
      lastContentItem = nonResults[i]
      break
    }
  }

  return {
    blockItems: lastContentItem
      ? nonResults.filter((i) => i !== lastContentItem)
      : nonResults,
    displayResults: results,
    responseText: lastContentItem?.kind === "content"
      ? lastContentItem.text
      : undefined,
  }
}, [activity.items])
```

### Render Structure

```tsx
{hasActivity && (
  <Card>
    <ActivityBlockHeader ... />
    <CollapsibleContent>
      {/* tools, thinking, narration — existing rendering */}
    </CollapsibleContent>
  </Card>
)}

{/* Display results render outside the card — always visible */}
{displayResults.map(item => (
  <DisplayResultRow key={item.id} item={item} />
))}

{/* Response text — existing rendering */}
{responseText && <MarkdownContent text={responseText} />}
```

## ToolDetail Routing for Bash

The existing `getToolCategory()` in `tool-utils.ts` already matches bash:

```typescript
// Existing: if (hasSegment(segments, ["bash", "terminal", "command", "exec", "execute"])) return "bash"
// "bash" tool name → segments ["bash"] → matches → category "bash" → BashDetail
```

The existing `BashDetail` component shows command + exit status + output. Extend it to also render `toolOutput` lines:

```typescript
// In BashDetail — add streaming output section
{tool.toolOutput && tool.toolOutput.length > 0 && (
  <ToolOutputBlock
    lines={tool.toolOutput}
    isStreaming={tool.status === "executing"}
  />
)}
```

The `ToolOutputBlock` component (formerly `PythonOutputBlock`) renders streaming stdout/stderr with auto-collapse behavior. See [inline-results.md](inline-results.md).

## Tool Category Extensions

Add to `tool-utils.ts`:

```typescript
// In getToolSummary():
if (category === "bash") {
  const cmd = readString(parsedArgs, ["command", "cmd"])
  return cmd ? cmd.split('\n')[0] : undefined
}

// In getActivitySummary():
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
  | "tool_output"       // NEW — persisted stdout/stderr
  | "display_result"    // NEW — persisted rich result (chart, table, image, mesh_ref)
```

The `turn-mapper.ts` must map `display_result` blocks into `DisplayResultItem` entries and `tool_output` blocks into `ToolItem.toolOutput` arrays when building `ActivityBlockData` from persisted data.

## Storybook Testing

Add streaming scenarios to `src/features/activity-stream/examples/`:

```typescript
// examples/bash-execution.ts
export const BASH_EXECUTION_SCENARIO: StreamEvent[] = [
  { type: "RUN_STARTED" },
  { type: "TOOL_CALL_START", toolCallId: "bash-001", toolCallName: "bash" },
  { type: "TOOL_CALL_ARGS", toolCallId: "bash-001", delta: '{"command":"python3 segment.py"}' },
  { type: "TOOL_OUTPUT", toolCallId: "bash-001", stream: "stdout", text: "Loading DICOM stack...", sequence: 0 },
  { type: "TOOL_OUTPUT", toolCallId: "bash-001", stream: "stdout", text: "Processing 200 slices...", sequence: 1 },
  { type: "DISPLAY_RESULT", toolCallId: "bash-001", resultType: "dataframe", data: {
    resultType: "dataframe", html: "<table>...</table>", title: "Scan Metadata", row_count: 5, col_count: 3
  }},
  { type: "DISPLAY_RESULT", toolCallId: "bash-001", resultType: "mesh_ref", data: {
    resultType: "mesh_ref", mesh_id: "mesh-001", vertex_count: 45000, face_count: 90000,
    label_names: { "1": "femur", "2": "tibia", "3": "patella" }
  }},
  { type: "TOOL_CALL_END", toolCallId: "bash-001" },
  { type: "TOOL_CALL_RESULT", toolCallId: "bash-001", content: '{"is_error":false,"result":"Segmentation complete"}' },
  { type: "TEXT_MESSAGE_START", messageId: "msg-001" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-001", delta: "The segmentation is complete..." },
  { type: "TEXT_MESSAGE_END", messageId: "msg-001" },
  { type: "RUN_FINISHED" },
]
```

## Related Docs

- [Inline Results](inline-results.md) — DisplayResultRow and block renderer components
- [3D Viewer](viewer-3d.md) — MeshRefBlock triggers viewer via workspace store
- [State Management](state.md) — viewer store receives mesh data from binary frames
- [Display Result Pipeline (backend)](../backend/display-results.md) — event payload contracts
