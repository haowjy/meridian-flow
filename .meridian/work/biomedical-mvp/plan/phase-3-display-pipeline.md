# Phase 3: Display Result Pipeline (Backend)

**Round 3** — Requires Phase 2 (OutputSink interface).

## Scope

Implement the OutputSink→emitter bridge (`aguiOutputSink`), new AG-UI emitter methods, event structs, and TurnBlock persistence for `tool_output` and `display_result` blocks. This completes the backend streaming pipeline.

## Intent

Phase 2 defined the OutputSink interface but didn't implement the bridge to the AG-UI emitter. This phase wires OutputSink calls to actual SSE events and WS binary frames, and persists output/results as TurnBlocks for reload.

## Files to Create

- `backend/internal/service/llm/streaming/agui_output_sink.go` — aguiOutputSink implementation
- `backend/internal/service/llm/streaming/agui/events/display.go` — MeridianToolOutputEvent, MeridianDisplayResultEvent structs

## Files to Modify

- `backend/internal/service/llm/streaming/agui/emitter.go` — Add `EmitToolOutput()`, `EmitDisplayResult()` methods
- `backend/internal/service/llm/streaming/stream_executor.go` — Create and inject OutputSink before tool execution
- `backend/internal/service/llm/streaming/tool_executor.go` — Persist tool_output and display_result TurnBlocks after execution
- `backend/internal/domain/llm/types.go` — Add `BlockTypeToolOutput`, `BlockTypeDisplayResult` constants

## Interface Contracts

```go
// aguiOutputSink wraps emitter + binary sender
type aguiOutputSink struct {
    emitter    *agui.Emitter
    binarySend func(subID string, data []byte) error
    messageID  string
    toolCallID string
}
```

## Dependencies

- Requires: Phase 2 (OutputSink interface, BashTool)
- Requires: Existing StreamExecutor, AG-UI emitter infrastructure
- Produces: Complete backend pipeline — tool output streams, display results emit, blocks persist

## Patterns to Follow

- Event structs: `backend/internal/service/llm/streaming/agui/events/` — existing MeridianRunStartedEvent pattern
- Emitter methods: `backend/internal/service/llm/streaming/agui/emitter.go` — existing EmitRunStarted pattern
- Block persistence: `backend/internal/service/llm/streaming/tool_executor.go` — existing tool_result persistence
- Binary send: `backend/internal/handler/thread_ws_handler.go` — existing SendBinaryToSub wiring

## Constraints

- OutputSink injection happens in stream_executor.go BEFORE tool execution
- The `binarySend` callback comes from the WS subscription handler
- tool_output blocks aggregate all lines for one tool call (one block, not one per line)
- display_result blocks are one per result (multiple per tool call possible)
- Event ordering: TOOL_OUTPUT during execution, DISPLAY_RESULT after, both before TOOL_CALL_END

## Verification Criteria

- [ ] `make build` passes
- [ ] `make test` passes
- [ ] Unit test: OutputSink.EmitToolOutput → emitter.EmitToolOutput called with correct args
- [ ] Unit test: OutputSink.EmitDisplayResult → emitter.EmitDisplayResult called
- [ ] Unit test: OutputSink.SendBinary → binarySend called with framed data
- [ ] Integration: tool_output and display_result blocks persisted after bash tool execution

## Agent Staffing

- **Implementer**: `coder` (backend Go, streaming layer)
- **Reviewer**: 1x reviewer (correctness — event ordering, block persistence)
- **Verifier**: `verifier`
