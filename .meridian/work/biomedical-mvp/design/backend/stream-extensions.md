# Stream Extensions for Python Execution

New AG-UI event types for streaming Python stdout/stderr and rich results (charts, tables, images, mesh references). Extends the existing streaming pipeline without changing the transport layer. See [overview](../overview.md) for system context.

## New Event Types

### PYTHON_OUTPUT

Streams stdout/stderr during Python execution. Sent incrementally as lines arrive from Daytona.

```typescript
// AG-UI event payload
{
  type: "PYTHON_OUTPUT",
  messageId: string,      // Parent assistant message
  toolCallId: string,     // The execute_python tool call
  stream: "stdout" | "stderr",
  text: string,           // One or more lines
  sequence: number        // Monotonic ordering
}
```

Emitted from Go:

```go
// In execute_python tool, during ExecStream callback:
func (t *ExecutePythonTool) onOutput(stream, data string) {
    t.emitter.EmitPythonOutput(t.messageID, t.toolCallID, stream, data, t.nextSeq())
}
```

### PYTHON_RESULT

Rich result from Python execution. Emitted after code completes when `__result__` data is parsed.

```typescript
// AG-UI event payload
{
  type: "PYTHON_RESULT",
  messageId: string,
  toolCallId: string,
  resultType: "plotly" | "image" | "dataframe" | "mesh_ref",
  data: object            // Type-specific payload (see below)
}
```

#### Plotly Result

```typescript
{
  resultType: "plotly",
  data: {
    plotly_json: string   // Full Plotly JSON spec (from fig.to_json())
  }
}
```

#### Image Result (matplotlib)

```typescript
{
  resultType: "image",
  data: {
    format: "png",
    base64: string,       // Base64-encoded PNG
    width?: number,
    height?: number
  }
}
```

#### DataFrame Result

```typescript
{
  resultType: "dataframe",
  data: {
    html: string,         // DataFrame.to_html() output
    title?: string,
    row_count: number,
    col_count: number
  }
}
```

#### Mesh Reference

For mesh data, the event contains metadata only. The actual binary data is sent separately via WS binary frame (to avoid base64 overhead in JSON events).

```typescript
{
  resultType: "mesh_ref",
  data: {
    mesh_id: string,          // Unique ID for this mesh
    vertex_count: number,
    face_count: number,
    label_names?: Record<number, string>,  // e.g., {1: "femur", 2: "tibia"}
    bounding_box?: {
      min: [number, number, number],
      max: [number, number, number]
    }
  }
}
```

Binary mesh data follows immediately via WebSocket binary frame:

```
Frame: <subId> 0x00 <mesh_id (UTF-8)> 0x00 <binary payload>

Binary payload layout:
  [4 bytes] vertex_count (uint32 LE)
  [4 bytes] face_count (uint32 LE)
  [vertex_count * 12 bytes] vertices (float32 x,y,z LE)
  [face_count * 12 bytes] faces (uint32 v0,v1,v2 LE)
  [vertex_count bytes] labels (uint8 per vertex, 0 if no labels)
```

## Integration with Existing Pipeline

### Backend Emitter Extensions

Add methods to the existing AG-UI emitter:

```go
// backend/internal/service/llm/streaming/agui/emitter.go

func (e *Emitter) EmitPythonOutput(messageID, toolCallID, stream, text string, seq int) {
    evt := events.NewPythonOutputEvent(messageID, toolCallID, stream, text, seq)
    e.EmitAGUIEvent(evt)
}

func (e *Emitter) EmitPythonResult(messageID, toolCallID string, result PythonResultPayload) {
    evt := events.NewPythonResultEvent(messageID, toolCallID, result)
    e.EmitAGUIEvent(evt)
}
```

### New Event Constructors

```go
// backend/internal/service/llm/streaming/agui/events/python.go

func NewPythonOutputEvent(messageID, toolCallID, stream, text string, seq int) Event {
    return baseEvent{
        eventType: "PYTHON_OUTPUT",
        payload: map[string]interface{}{
            "messageId":  messageID,
            "toolCallId": toolCallID,
            "stream":     stream,
            "text":       text,
            "sequence":   seq,
        },
    }
}

func NewPythonResultEvent(messageID, toolCallID string, result PythonResultPayload) Event {
    return baseEvent{
        eventType: "PYTHON_RESULT",
        payload: map[string]interface{}{
            "messageId":  messageID,
            "toolCallId": toolCallID,
            "resultType": result.Type,
            "data":       result.Data,
        },
    }
}
```

### TurnBlock Persistence

Python results are persisted as TurnBlocks for history/reload:

```go
// New block types
const (
    BlockTypePythonOutput = "python_output"   // stdout/stderr text
    BlockTypePythonResult = "python_result"   // rich result (chart, table, image, mesh)
)
```

A `python_result` block's `Content` map:

```json
{
  "tool_use_id": "toolu_...",
  "result_type": "plotly",
  "data": { "plotly_json": "..." }
}
```

For mesh results, the binary data is NOT stored in the block. Instead, the mesh is exported as STL/OBJ to the sandbox's `/workspace/outputs/` directory, and the block stores a reference:

```json
{
  "tool_use_id": "toolu_...",
  "result_type": "mesh_ref",
  "data": {
    "mesh_id": "mesh_abc123",
    "vertex_count": 50000,
    "face_count": 100000,
    "label_names": {"1": "femur", "2": "tibia", "3": "patella"},
    "stl_path": "/workspace/outputs/segmentation_001.stl"
  }
}
```

When the user reloads the page, the 3D viewer can re-fetch the mesh from the sandbox (if running) or show a "sandbox stopped" state with the option to resume.

### Frontend Event Handlers

New handlers in the SSE event dispatcher:

```
frontend/src/features/threads/hooks/sse/eventHandlers/
  pythonOutputHandler.ts    # Appends stdout/stderr to streaming turn
  pythonResultHandler.ts    # Renders rich results (chart, table, image, mesh)
```

These follow the existing pattern — update thread store, trigger re-render of the affected turn's blocks.

## Event Ordering Guarantees

1. `TOOL_CALL_START` for `execute_python` always precedes `PYTHON_OUTPUT` events
2. `PYTHON_OUTPUT` events arrive in `sequence` order
3. `PYTHON_RESULT` events arrive after all `PYTHON_OUTPUT` for that execution
4. `TOOL_CALL_END` arrives after all `PYTHON_OUTPUT` and `PYTHON_RESULT` events
5. Binary mesh frame arrives within 1 second of the `PYTHON_RESULT` with `mesh_ref` type

## Buffering

High-frequency stdout (e.g., progress bars) is buffered:
- **Backend**: Daytona output is line-buffered. Lines are batched into 100ms windows before emission.
- **Frontend**: Existing 50ms text delta flush interval handles display smoothly.

## Related Docs

- [execute_python Tool](execute-python.md) — produces these events
- [Inline Results](../frontend/inline-results.md) — renders PYTHON_RESULT events
- [3D Viewer](../frontend/viewer-3d.md) — consumes mesh_ref + binary data
