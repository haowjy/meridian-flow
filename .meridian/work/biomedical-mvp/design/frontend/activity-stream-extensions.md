# Activity Stream Extensions

Extends v2's AG-UI event reducer to handle Python execution events: streaming stdout/stderr and rich results (charts, tables, images, mesh references). See [overview](overview.md) for how this fits into the frontend architecture.

## Current State

The activity stream reducer (`src/features/activity-stream/streaming/reducer.ts`) processes `StreamEvent` into `ActivityBlockData`. Events are a discriminated union on `type`. The `ActivityItem` union is currently `ThinkingItem | ContentItem | ToolItem`.

## New Event Types

Add to the `StreamEvent` union in `src/features/activity-stream/streaming/events.ts`:

```typescript
export type StreamEvent =
  // ... existing events ...
  // Python execution (Meridian extension)
  | {
      type: "PYTHON_OUTPUT"
      toolCallId: string
      stream: "stdout" | "stderr"
      text: string
      sequence: number
    }
  | {
      type: "PYTHON_RESULT"
      toolCallId: string
      resultType: "plotly" | "image" | "dataframe" | "mesh_ref"
      data: PythonResultPayload
    }
```

Add `"PYTHON_OUTPUT"` and `"PYTHON_RESULT"` to the `STREAM_EVENT_TYPES` array.

## New Activity Types

Add to `src/features/activity-stream/types.ts`:

```typescript
/** Accumulated stdout/stderr line from execute_python. Stored on ToolItem. */
export type PythonOutputLine = {
  stream: "stdout" | "stderr"
  text: string
  sequence: number
}

/** Rich result payload from execute_python. Stored on ResultItem. */
export type PythonResultPayload =
  | { resultType: "plotly"; plotly_json: object }
  | { resultType: "image"; base64: string; format: string }
  | { resultType: "dataframe"; html: string; title?: string; row_count: number; col_count: number }
  | { resultType: "mesh_ref"; mesh_id: string; vertex_count: number; face_count: number; label_names?: Record<string, string> }

/**
 * Rich result from execute_python. Renders as a prominent block
 * in the activity stream — always visible, not hidden in the
 * collapsible tool detail.
 */
export type ResultItem = {
  kind: "result"
  id: string             // `${toolCallId}-result-${sequence}`
  toolCallId: string     // Links back to the ToolItem
  data: PythonResultPayload
}
```

Extend the existing types:

```typescript
// Extended ToolItem — add pythonOutput field
export type ToolItem = {
  // ... existing fields ...
  /** Accumulated stdout/stderr lines from PYTHON_OUTPUT events. */
  pythonOutput?: PythonOutputLine[]
}

// Extended ActivityItem union
export type ActivityItem = ThinkingItem | ContentItem | ToolItem | ResultItem
```

## Reducer Logic

Add cases to `reduceStreamEvent()` in `src/features/activity-stream/streaming/reducer.ts`:

```typescript
case "PYTHON_OUTPUT": {
  // Append to the execute_python ToolItem's pythonOutput buffer
  const line: PythonOutputLine = {
    stream: event.stream,
    text: event.text,
    sequence: event.sequence,
  }
  const items = updateItemById<ToolItem>(
    state.activity.items,
    event.toolCallId,
    (item) => ({
      ...item,
      pythonOutput: [...(item.pythonOutput ?? []), line],
    })
  )
  return {
    ...state,
    activity: { ...state.activity, items },
  }
}

case "PYTHON_RESULT": {
  // Create a new ResultItem in the activity items array
  const existingResults = state.activity.items.filter(
    (i) => i.kind === "result" && i.toolCallId === event.toolCallId
  )
  const resultItem: ResultItem = {
    kind: "result",
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

Events arrive in this guaranteed order per tool call (per [backend stream-extensions.md](../backend/stream-extensions.md)):

```
TOOL_CALL_START (execute_python)
  TOOL_CALL_ARGS (code parameter, may be multiple deltas)
  PYTHON_OUTPUT (0..N, sequenced — streaming during execution)
  PYTHON_RESULT (0..N, after all PYTHON_OUTPUT)
  TOOL_CALL_END (after all Python events)
TOOL_CALL_RESULT (final status)
```

**Important**: `TOOL_CALL_END` arrives AFTER all Python events, not before. This means Python events arrive while the tool's reducer status is still `"streaming-args"` (because `TOOL_CALL_END` is what transitions to `"executing"`). The `PYTHON_OUTPUT` handler must therefore also transition the tool to `"executing"` on first arrival:

```typescript
case "PYTHON_OUTPUT": {
  const line: PythonOutputLine = {
    stream: event.stream,
    text: event.text,
    sequence: event.sequence,
  }
  const items = updateItemById<ToolItem>(
    state.activity.items,
    event.toolCallId,
    (item) => ({
      ...item,
      // Transition to "executing" on first Python output if still streaming args
      status: item.status === "streaming-args" ? "executing" : item.status,
      pythonOutput: [...(item.pythonOutput ?? []), line],
    })
  )
  return {
    ...state,
    activity: { ...state.activity, items },
  }
}
```

## Persisted Turn Blocks

The backend persists `python_output` and `python_result` as new `BlockType` values in the turn_blocks table. When the user reloads, the turn-mapper must reconstruct activity from these persisted blocks. Add to `frontend-v2/src/features/threads/types.ts`:

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
  | "python_output"    // NEW — persisted stdout/stderr
  | "python_result"    // NEW — persisted rich result (chart, table, image, mesh_ref)
```

The `turn-mapper.ts` must map these block types into the correct `ActivityItem` types when building `ActivityBlockData` from persisted data (not just from streaming events).

## Rendering Integration

### ResultItem rendering in ActivityBlock

ResultItems need special treatment in `ActivityBlock.tsx`. They should render **outside** the collapsible Card, similar to how the last ContentItem's text renders below the card. This makes rich results always visible in the chat flow.

```typescript
// In ActivityBlock's useMemo:
const { blockItems, responseText, resultItems } = useMemo(() => {
  // Separate result items from other items
  const results: ResultItem[] = []
  const nonResults: ActivityItem[] = []

  for (const item of activity.items) {
    if (item.kind === "result") {
      results.push(item)
    } else {
      nonResults.push(item)
    }
  }

  // Existing lastContentItem logic on nonResults
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
    responseText: lastContentItem?.kind === "content"
      ? lastContentItem.text
      : undefined,
    resultItems: results,
  }
}, [activity.items])
```

```tsx
// In ActivityBlock's render:
{hasActivity && (
  <Card>
    <ActivityBlockHeader ... />
    <CollapsibleContent>
      {/* tools, thinking, narration — existing rendering */}
    </CollapsibleContent>
  </Card>
)}

{/* Rich results render outside the card — always visible */}
{resultItems.map(item => (
  <ResultRow key={item.id} item={item} />
))}

{/* Response text — existing rendering */}
{responseText && <p>...</p>}
```

### PythonDetail in ToolDetail routing

Add `"python"` to the tool category system in `tool-utils.ts`:

```typescript
// In getToolCategory() — MUST be placed BEFORE the bash check.
// "execute_python" splits to segments ["execute", "python"].
// The bash check matches "execute", so python must win first.
if (hasSegment(segments, ["python"])) {
  return "python"
}

// Existing bash check (line ~65) stays where it is:
// if (hasSegment(segments, ["bash", "terminal", "command", "exec", "execute"])) ...
```

**Ordering requirement**: The python check must appear before the bash check in `getToolCategory()`. The existing bash candidates include `"execute"` and `"exec"`, both of which match `execute_python`. Without this ordering, `execute_python` is silently classified as `"bash"` and routed to the wrong detail renderer.

Then route to `PythonDetail` in `ToolDetail.tsx`:

```typescript
if (category === "python") {
  return <PythonDetail tool={tool} />
}
```

See [inline-results.md](inline-results.md) for `PythonDetail` and `ResultRow` component designs.

## Tool Category Extensions

Add to `tool-utils.ts`:

```typescript
export type ToolCategory = "read" | "edit" | "doc-search" | "web-search"
  | "bash" | "agent" | "python" | "other"

// In getToolLabel():
if (category === "python") return "Python"

// In getToolIcon():
if (category === "python") return FlaskConical  // or Code from Phosphor

// In getToolSummary():
if (category === "python") {
  // Show a truncated preview of the code
  const code = readString(parsedArgs, ["code", "script"])
  return code ? code.split('\n')[0] : undefined
}

// In getActivitySummary():
if (counts.python > 0) {
  parts.push(`ran ${counts.python} ${pluralize(counts.python, "script", "scripts")}`)
}
```

## Storybook Testing

Add streaming scenarios to `src/features/activity-stream/examples/`:

```typescript
// examples/python-execution.ts
export const PYTHON_EXECUTION_SCENARIO: StreamEvent[] = [
  { type: "RUN_STARTED" },
  { type: "TOOL_CALL_START", toolCallId: "py-001", toolCallName: "execute_python" },
  { type: "TOOL_CALL_ARGS", toolCallId: "py-001", delta: '{"code":"import SimpleITK..."}' },
  { type: "TOOL_CALL_END", toolCallId: "py-001" },
  { type: "PYTHON_OUTPUT", toolCallId: "py-001", stream: "stdout", text: "Loading DICOM stack...", sequence: 0 },
  { type: "PYTHON_OUTPUT", toolCallId: "py-001", stream: "stdout", text: "Processing 200 slices...", sequence: 1 },
  { type: "PYTHON_OUTPUT", toolCallId: "py-001", stream: "stderr", text: "Warning: slice gap detected", sequence: 2 },
  { type: "PYTHON_RESULT", toolCallId: "py-001", resultType: "dataframe", data: {
    resultType: "dataframe", html: "<table>...</table>", title: "Scan Metadata", row_count: 5, col_count: 3
  }},
  { type: "PYTHON_RESULT", toolCallId: "py-001", resultType: "mesh_ref", data: {
    resultType: "mesh_ref", mesh_id: "mesh-001", vertex_count: 45000, face_count: 90000,
    label_names: { "1": "femur", "2": "tibia", "3": "patella" }
  }},
  { type: "TOOL_CALL_RESULT", toolCallId: "py-001", content: '{"is_error":false,"result":"Segmentation complete"}' },
  { type: "TEXT_MESSAGE_START", messageId: "msg-001" },
  { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-001", delta: "The segmentation is complete..." },
  { type: "TEXT_MESSAGE_END", messageId: "msg-001" },
  { type: "RUN_FINISHED" },
]
```

## Related Docs

- [Inline Results](inline-results.md) — ResultRow, PythonDetail, and block renderer components
- [3D Viewer](viewer-3d.md) — MeshRefBlock triggers viewer via workspace store
- [State Management](state.md) — viewer store receives mesh data from binary frames
- [Stream Extensions (backend)](../backend/stream-extensions.md) — event payload contracts
