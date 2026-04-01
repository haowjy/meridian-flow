# Stream Extensions for Python Execution

New AG-UI event types for streaming Python stdout/stderr and rich results. Extends the existing streaming pipeline. See [overview](../overview.md) for system context.

## Architecture: How Streaming Flows

The key constraint is that tools don't have emitter access (see [execute-python.md](execute-python.md) §Architecture Constraint). Streaming flows through the `OutputSink` interface, implemented by the `StreamExecutor`:

```
execute_python tool
    ↓ calls sink.EmitOutput() / sink.EmitResult() / sink.SendBinary()
OutputSink (implemented by aguiOutputSink in stream_executor.go)
    ↓ delegates to
AG-UI Emitter (for JSON events) + BinarySender (for mesh data)
    ↓
mstream SSE transport (JSON events) / WS binary frames (mesh data)
    ↓
Frontend event handlers
```

### OutputSink Implementation in StreamExecutor

```go
// backend/internal/service/llm/streaming/agui_output_sink.go

type aguiOutputSink struct {
    emitter    *agui.Emitter
    binarySend func(subID string, data []byte) error  // From WS subscription
    messageID  string
    toolCallID string
}

func (s *aguiOutputSink) EmitOutput(stream, text string, seq int) {
    s.emitter.EmitPythonOutput(s.messageID, s.toolCallID, stream, text, seq)
}

func (s *aguiOutputSink) EmitResult(result tools.PythonResultPayload) {
    s.emitter.EmitPythonResult(s.messageID, s.toolCallID, result)
}

func (s *aguiOutputSink) SendBinary(meshID string, data []byte) {
    if s.binarySend != nil {
        // Frame: meshID (UTF-8) + 0x00 delimiter + binary payload
        frame := buildMeshFrame(meshID, data)
        s.binarySend(s.toolCallID, frame)
    }
}
```

### BinarySender Plumbing

The WS subscription handler provides a `binarySend` callback when setting up the SSE stream. This connects the streaming layer to the WS session's `SendBinaryToSub`:

```go
// In the WS subscription setup (when stream starts):
binarySend := func(subID string, data []byte) error {
    return wsSession.SendBinaryToSub(subID, data)
}
// Pass binarySend into StreamExecutor or OutputSink constructor
```

## New Event Types

### PYTHON_OUTPUT

Streams stdout/stderr during execution. Incremental lines.

```typescript
{
  type: "PYTHON_OUTPUT",
  messageId: string,
  toolCallId: string,
  stream: "stdout" | "stderr",
  text: string,
  sequence: number
}
```

### PYTHON_RESULT

Rich result after code completes. One event per result (a single execution can produce multiple).

```typescript
{
  type: "PYTHON_RESULT",
  messageId: string,
  toolCallId: string,
  resultType: "plotly" | "image" | "dataframe" | "mesh_ref",
  data: PlotlyData | ImageData | DataFrameData | MeshRefData
}
```

#### Plotly Result
```typescript
interface PlotlyData {
  plotly_json: object  // Plotly figure spec (data + layout)
}
```

#### Image Result (matplotlib)
```typescript
interface ImageData {
  format: "png"
  base64: string       // Base64-encoded image
}
```

#### DataFrame Result
```typescript
interface DataFrameData {
  html: string         // Sanitized HTML table
  title?: string
  row_count: number
  col_count: number
}
```

#### Mesh Reference
Metadata only. Binary data arrives separately via WS binary frame.

```typescript
interface MeshRefData {
  mesh_id: string
  vertex_count: number
  face_count: number
  label_names?: Record<string, string>  // String keys (JSON constraint)
}
```

### Binary Mesh Frame (WS)

Sent via WS binary frame immediately after the `PYTHON_RESULT` mesh_ref event:

```
WS Binary Frame:
  [subId bytes] 0x00 [meshId UTF-8] 0x00 [binary payload]

Binary payload layout (all little-endian):
  [4 bytes] vertex_count (uint32)
  [4 bytes] face_count (uint32)
  [vertex_count * 12 bytes] vertices (float32 x,y,z)
  [face_count * 12 bytes] faces (uint32 v0,v1,v2)
  [vertex_count bytes] labels (uint8 per vertex)
```

Frontend must copy payload into an aligned buffer before constructing typed array views (DataView for parsing, then copy into Float32Array/Uint32Array).

## Backend Emitter Methods

New methods on the existing AG-UI emitter, using typed struct events (not map[string]interface{}):

```go
// backend/internal/service/llm/streaming/agui/emitter.go

func (e *Emitter) EmitPythonOutput(messageID, toolCallID, stream, text string, seq int) {
    evt := events.MeridianPythonOutputEvent{
        Type:       "PYTHON_OUTPUT",
        MessageID:  messageID,
        ToolCallID: toolCallID,
        Stream:     stream,
        Text:       text,
        Sequence:   seq,
    }
    e.emitMeridianEvent("PYTHON_OUTPUT", evt)
}

func (e *Emitter) EmitPythonResult(messageID, toolCallID string, result tools.PythonResultPayload) {
    evt := events.MeridianPythonResultEvent{
        Type:       "PYTHON_RESULT",
        MessageID:  messageID,
        ToolCallID: toolCallID,
        ResultType: result.Type,
        Data:       result.Data,
    }
    e.emitMeridianEvent("PYTHON_RESULT", evt)
}
```

### Event Structs

Follow the existing Meridian event pattern (typed structs with JSON tags):

```go
// backend/internal/service/llm/streaming/agui/events/python.go

type MeridianPythonOutputEvent struct {
    Type       string `json:"type"`
    MessageID  string `json:"messageId"`
    ToolCallID string `json:"toolCallId"`
    Stream     string `json:"stream"`
    Text       string `json:"text"`
    Sequence   int    `json:"sequence"`
}

type MeridianPythonResultEvent struct {
    Type       string      `json:"type"`
    MessageID  string      `json:"messageId"`
    ToolCallID string      `json:"toolCallId"`
    ResultType string      `json:"resultType"`
    Data       interface{} `json:"data"`
}
```

## TurnBlock Persistence

New block type constants:

```go
const (
    BlockTypePythonOutput = "python_output"
    BlockTypePythonResult = "python_result"
)
```

### Aggregation Strategy

- **python_output**: One block per `execute_python` invocation, aggregating all stdout/stderr lines. Updated incrementally during streaming, finalized when execution completes.
- **python_result**: One block per rich result. Multiple blocks possible per execution.

The `StreamExecutor` persists these blocks in `executeToolsAndContinue()`, following the same pattern as `tool_result` block persistence.

### Mesh Persistence

Binary mesh data is NOT stored in TurnBlocks. The mesh file remains in the sandbox at `/workspace/.meridian/meshes/{mesh_id}.bin`. The `python_result` block stores a reference:

```json
{
  "result_type": "mesh_ref",
  "mesh_id": "mesh_abc123",
  "vertex_count": 50000,
  "face_count": 100000,
  "label_names": {"1": "femur", "2": "tibia"}
}
```

On page reload, the frontend shows the mesh reference card. If the sandbox is running, it can re-fetch the binary data. If stopped, it shows a "Resume sandbox" prompt.

## Frontend Event Handlers

Target: `frontend/` (production app), not `frontend-v2/`.

New handlers in the SSE event dispatcher:

```
frontend/src/features/threads/hooks/sse/eventHandlers/
  pythonOutputHandler.ts
  pythonResultHandler.ts
```

Register in `SSEEventDispatcher.ts` alongside existing handlers.

### Thread Store Extensions

```typescript
// New actions in useThreadStore:
appendPythonOutput(toolCallId: string, line: { stream: string; text: string; sequence: number }): void
addPythonResult(toolCallId: string, result: PythonResult): void
```

## Event Ordering

1. `TOOL_CALL_START` for `execute_python` precedes all Python events
2. `PYTHON_OUTPUT` events arrive in `sequence` order
3. `PYTHON_RESULT` events arrive after all `PYTHON_OUTPUT` for that execution
4. Binary mesh frame arrives within 1 second of `PYTHON_RESULT` with mesh_ref type
5. `TOOL_CALL_END` arrives after all Python events

## Buffering

- **Backend**: Daytona output is line-buffered. Lines batched into 100ms windows before emission.
- **Frontend**: Existing 50ms text delta flush interval handles display smoothly.

## Related Docs

- [execute_python Tool](execute-python.md) — produces these events via OutputSink
- [Inline Results](../frontend/inline-results.md) — renders PYTHON_RESULT events
- [3D Viewer](../frontend/viewer-3d.md) — consumes mesh_ref + binary data
