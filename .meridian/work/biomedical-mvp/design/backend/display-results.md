# Display Result Pipeline

Generic mechanism for tools to emit rich results (charts, images, tables, mesh references) that render **inline with text** in the chat. Results are content — they appear in the visible zone of the ActivityBlock alongside text, not in a separate rendering area. See [overview](../overview.md) for system context.

**Key principle**: DISPLAY_RESULT events are a transport mechanism. The frontend renders them inline in the visible zone of the ActivityBlock, interleaved with text content. They are content, like text.

## Two Event Types

### 1. TOOL_OUTPUT — Streaming stdout/stderr

Streams tool execution output. Per-tool-category display config determines whether stdout appears in the collapsed or visible zone. See [activity-stream.md](../frontend/activity-stream.md) for the two-zone model.

```typescript
{
  type: "TOOL_OUTPUT",
  messageId: string,
  toolCallId: string,
  stream: "stdout" | "stderr",
  text: string,
  sequence: number
}
```

### 2. DISPLAY_RESULT — Rich inline results

Rich result that renders inline in the visible zone of the ActivityBlock. Any tool can emit these via `OutputSink.EmitDisplayResult()`.

```typescript
{
  type: "DISPLAY_RESULT",
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
  base64: string
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
Metadata only. Binary data arrives separately via WS binary frame. One mesh per result — the AI sends multiple `show_mesh()` calls to build a multi-mesh scene.

```typescript
interface MeshRefData {
  mesh_id: string        // AI-chosen ID (e.g. "femur", "tibia")
  vertex_count: number
  face_count: number
  label: string          // Display name (e.g. "Femur")
  color: string          // Hex color (e.g. "#4488ff")
}
```

**Change from previous design**: No `label_names` map. Each mesh is a single named structure with one color, identified by `mesh_id`. Same `mesh_id` replaces an existing mesh in the viewer; new `mesh_id` adds to the scene.

## Architecture: How Streaming Flows

```
python tool (primary) or any tool
    | calls sink.EmitToolOutput() / sink.EmitDisplayResult() / sink.SendBinary()
OutputSink (implemented by aguiOutputSink in stream_executor.go)
    | delegates to
AG-UI Emitter (for JSON events) + BinarySender (for mesh data)
    |
mstream SSE transport (JSON events) / WS binary frames (mesh data)
    |
Frontend event handlers -> inline rendering in visible zone
```

## OutputSink Interface

```go
// backend/internal/service/llm/tools/output_sink.go

// OutputSink allows tools to emit intermediate output during execution.
// Injected into context by StreamExecutor. Any tool can use it.
type OutputSink interface {
    // EmitToolOutput streams a line of stdout/stderr to the frontend.
    EmitToolOutput(stream string, text string, seq int)
    // EmitDisplayResult sends a rich result (chart, table, image, mesh metadata).
    EmitDisplayResult(result DisplayResultPayload)
    // SendBinary sends raw binary data (mesh vertices/faces) to the frontend.
    SendBinary(meshID string, data []byte)
}

// Context injection
type outputSinkKey struct{}

func OutputSinkFromContext(ctx context.Context) OutputSink {
    sink, _ := ctx.Value(outputSinkKey{}).(OutputSink)
    return sink
}

func ContextWithOutputSink(ctx context.Context, sink OutputSink) context.Context {
    return context.WithValue(ctx, outputSinkKey{}, sink)
}
```

### DisplayResultPayload

```go
// backend/internal/service/llm/tools/display_result.go

type DisplayResultPayload struct {
    Type string      `json:"type"`  // "plotly", "image", "dataframe", "mesh_ref"
    Data interface{} `json:"data"`
}
```

## OutputSink Implementation in StreamExecutor

```go
// backend/internal/service/llm/streaming/agui_output_sink.go

type aguiOutputSink struct {
    emitter    *agui.Emitter
    binarySend func(subID string, data []byte) error
    messageID  string
    toolCallID string
}

func (s *aguiOutputSink) EmitToolOutput(stream, text string, seq int) {
    s.emitter.EmitToolOutput(s.messageID, s.toolCallID, stream, text, seq)
}

func (s *aguiOutputSink) EmitDisplayResult(result tools.DisplayResultPayload) {
    s.emitter.EmitDisplayResult(s.messageID, s.toolCallID, result)
}

func (s *aguiOutputSink) SendBinary(meshID string, data []byte) {
    if s.binarySend != nil {
        frame := buildMeshFrame(meshID, data)
        s.binarySend(s.toolCallID, frame)
    }
}
```

### StreamExecutor Integration

```go
// In stream_executor.go, before calling registry.Execute():
sink := &aguiOutputSink{
    emitter:     se.aguiEmitter,
    binarySend:  se.binarySendFunc,
    messageID:   se.lastAssistantMessageID,
    toolCallID:  call.ID,
}
ctx = tools.ContextWithOutputSink(ctx, sink)
```

### BinarySender Plumbing

```go
binarySend := func(subID string, data []byte) error {
    return wsSession.SendBinaryToSub(subID, data)
}
```

## Binary Mesh Frame (WS)

Sent via WS binary frame after the `DISPLAY_RESULT` mesh_ref event:

```
WS Binary Frame:
  [subId bytes] 0x00 [meshId UTF-8] 0x00 [binary payload]

Binary payload layout (all little-endian):
  [4 bytes] vertex_count (uint32)
  [4 bytes] face_count (uint32)
  [vertex_count * 12 bytes] vertices (float32 x,y,z)
  [face_count * 12 bytes] faces (uint32 v0,v1,v2)
```

**Simplified from previous design**: No per-vertex labels in the binary. Each mesh is one complete structure. The `mesh_id`, `label`, and `color` come from the DISPLAY_RESULT event metadata.

Frontend must copy payload into aligned buffers before constructing typed array views (Decision D9).

## Backend Emitter Methods

New methods on the AG-UI emitter:

```go
func (e *Emitter) EmitToolOutput(messageID, toolCallID, stream, text string, seq int) {
    evt := events.MeridianToolOutputEvent{
        Type:       "TOOL_OUTPUT",
        MessageID:  messageID,
        ToolCallID: toolCallID,
        Stream:     stream,
        Text:       text,
        Sequence:   seq,
    }
    e.emitMeridianEvent("TOOL_OUTPUT", evt)
}

func (e *Emitter) EmitDisplayResult(messageID, toolCallID string, result tools.DisplayResultPayload) {
    evt := events.MeridianDisplayResultEvent{
        Type:       "DISPLAY_RESULT",
        MessageID:  messageID,
        ToolCallID: toolCallID,
        ResultType: result.Type,
        Data:       result.Data,
    }
    e.emitMeridianEvent("DISPLAY_RESULT", evt)
}
```

### Event Structs

```go
// backend/internal/service/llm/streaming/agui/events/display.go

type MeridianToolOutputEvent struct {
    Type       string `json:"type"`
    MessageID  string `json:"messageId"`
    ToolCallID string `json:"toolCallId"`
    Stream     string `json:"stream"`
    Text       string `json:"text"`
    Sequence   int    `json:"sequence"`
}

type MeridianDisplayResultEvent struct {
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
    BlockTypeToolOutput    = "tool_output"
    BlockTypeDisplayResult = "display_result"
)
```

### Aggregation Strategy

- **tool_output**: One block per tool invocation, aggregating all stdout/stderr lines. Finalized when execution completes.
- **display_result**: One block per rich result. Multiple blocks possible per tool execution (e.g. multiple `show_mesh()` calls).

### Persisted Block Content Schemas

**tool_output block** (`block_type: "tool_output"`):
```json
{
  "tool_use_id": "call_abc123",
  "tool_name": "python",
  "lines": [
    { "stream": "stdout", "text": "Loading DICOM stack...", "sequence": 0 },
    { "stream": "stderr", "text": "Warning: slice gap", "sequence": 1 }
  ]
}
```

**display_result block** (`block_type: "display_result"`):
```json
{
  "tool_use_id": "call_abc123",
  "result_type": "plotly",
  "data": { "plotly_json": { "data": [], "layout": {} } }
}
```

```json
{
  "tool_use_id": "call_abc123",
  "result_type": "image",
  "data": { "format": "png", "base64": "..." }
}
```

```json
{
  "tool_use_id": "call_abc123",
  "result_type": "dataframe",
  "data": { "html": "<table>...</table>", "title": "Stats", "row_count": 5, "col_count": 3 }
}
```

```json
{
  "tool_use_id": "call_abc123",
  "result_type": "mesh_ref",
  "data": {
    "mesh_id": "femur",
    "vertex_count": 50000,
    "face_count": 100000,
    "label": "Femur",
    "color": "#4488ff"
  }
}
```

The `turn-mapper.ts` reads `result_type` to construct the correct `DisplayResultPayload` variant. For `tool_output` blocks, the `tool_name` field determines which tool category's display config to apply. The `lines` array maps to the tool's output data.

### Mesh Persistence

Binary mesh data is NOT stored in TurnBlocks. The mesh file remains in the sandbox. The `display_result` block stores a `mesh_ref` reference.

On page reload, the frontend shows the mesh reference card. Mesh binary is transient (in-memory only). The researcher re-runs segmentation or continues in the same session.

## Event Ordering

Events arrive in this order per tool call:

```
TOOL_CALL_START (python or bash)
  TOOL_CALL_ARGS (code/command parameter, may be multiple deltas)
  TOOL_CALL_END (fires when LLM finishes writing tool_use block -- before execution)
  TOOL_OUTPUT (0..N, sequenced -- streaming during execution)
  DISPLAY_RESULT (0..N, after execution completes -- python tool only)
TOOL_CALL_RESULT (final status)
```

**Important**: `TOOL_CALL_END` is an AG-UI protocol event emitted by the SSE library when the LLM finishes streaming the tool_use block. It fires **before** tool execution starts and transitions the tool status to `"executing"`. The backend does not control when `TOOL_CALL_END` fires — it's generated during response parsing. `TOOL_OUTPUT` and `DISPLAY_RESULT` events arrive during/after execution, well after `TOOL_CALL_END`.

## Buffering

- **Backend**: Daytona output is line-buffered. Lines batched into 100ms windows before emission.
- **Frontend**: Existing 50ms text delta flush interval handles display smoothly.

## Related Docs

- [Python Tool](python-tool.md) — produces display results via OutputSink
- [Bash Tool](bash-tool.md) — produces tool output only (no display results)
- [Activity Stream](../frontend/activity-stream.md) — frontend event handling + two-zone model
- [Inline Results](../frontend/inline-results.md) — renders DISPLAY_RESULT events inline
- [3D Viewer](../frontend/viewer-3d.md) — consumes mesh_ref + binary data
