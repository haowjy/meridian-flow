# Phase 4: AG-UI Stream Extensions

**Round 2** — Can run in parallel with Phase 3 (shares no files).

## Scope

Add new AG-UI event types (`PYTHON_OUTPUT`, `PYTHON_RESULT`) to the streaming pipeline, plus binary mesh frame handling via existing WS binary support. Add new TurnBlock types for persistence.

## Intent

Python execution needs to stream results to the frontend in real-time. This phase extends the existing AG-UI event infrastructure with new event constructors, emitter methods, and TurnBlock types. The execute_python tool (Phase 3) calls these emitter methods; the frontend (Phase 5) handles these events.

## Files to Create

- `backend/internal/service/llm/streaming/agui/events/python.go` — Typed event structs (MeridianPythonOutputEvent, MeridianPythonResultEvent)
- `backend/internal/service/llm/streaming/agui/events/python_test.go`
- `backend/internal/service/llm/streaming/agui_output_sink.go` — `aguiOutputSink` implementing `tools.OutputSink`

## Files to Modify

- `backend/internal/service/llm/streaming/agui/emitter.go` — Add EmitPythonOutput(), EmitPythonResult()
- `backend/internal/service/llm/streaming/tool_executor.go` — Inject OutputSink into context before tool execution
- `backend/internal/domain/llm/turn_block.go` — Add BlockTypePythonOutput, BlockTypePythonResult constants
- `backend/internal/domain/llm/content_types.go` — Add PythonOutputContent, PythonResultContent types

## Interface Contract

### New Emitter Methods
```go
func (e *Emitter) EmitPythonOutput(messageID, toolCallID, stream, text string, seq int)
func (e *Emitter) EmitPythonResult(messageID, toolCallID string, result PythonResultPayload)
func (e *Emitter) EmitBinaryMesh(subID string, meshID string, data []byte)
```

### New Event Types
```go
// PYTHON_OUTPUT event payload
type PythonOutputPayload struct {
    MessageID  string `json:"messageId"`
    ToolCallID string `json:"toolCallId"`
    Stream     string `json:"stream"`     // "stdout" | "stderr"
    Text       string `json:"text"`
    Sequence   int    `json:"sequence"`
}

// PYTHON_RESULT event payload
type PythonResultPayload struct {
    MessageID  string      `json:"messageId"`
    ToolCallID string      `json:"toolCallId"`
    ResultType string      `json:"resultType"` // "plotly" | "image" | "dataframe" | "mesh_ref"
    Data       interface{} `json:"data"`
}
```

### New Block Types
```go
const (
    BlockTypePythonOutput = "python_output"
    BlockTypePythonResult = "python_result"
)
```

## Dependencies

- Requires: None (extends existing infrastructure)
- Consumed by: Phase 3 (execute_python tool calls these emitters)
- Consumed by: Phase 5 (frontend handles these events)

## Patterns to Follow

- Event constructors: `backend/internal/service/llm/streaming/agui/events/` (existing event patterns)
- Emitter methods: `emitter.go` line ~150+ (EmitToolCallResult pattern)
- Block types: `turn_block.go` (existing constants)
- Content types: `content_types.go` (existing struct patterns)

## Verification Criteria

- [ ] `make build` passes
- [ ] `make test` passes (event serialization round-trips correctly)
- [ ] PYTHON_OUTPUT event serializes to valid JSON matching AG-UI format
- [ ] PYTHON_RESULT event supports all four result types
- [ ] New block types are recognized by existing block persistence code

## Agent Staffing

- **Implementer**: `coder` (small, well-scoped extension of existing code)
- **Verifier**: `verifier`
