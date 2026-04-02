# Phase 2: Bash Tool + OutputSink

**Round 2** — Requires Phase 1 (Daytona Service).

## Scope

Implement the `bash` ToolExecutor and the generic `OutputSink` interface for streaming tool output and display results. This phase wires the tool to the sandbox service and makes it available in the tool registry.

## Intent

The AI agent needs a bash tool to run commands in the Daytona sandbox. Python scripts are detected and routed through the persistent kernel. The OutputSink interface enables any tool to stream intermediate output and emit display results.

## Files to Create

- `backend/internal/service/llm/tools/bash_tool.go` — BashTool ToolExecutor
- `backend/internal/service/llm/tools/bash_tool_meta.go` — Tool metadata
- `backend/internal/service/llm/tools/bash_tool_test.go` — Unit tests
- `backend/internal/service/llm/tools/output_sink.go` — OutputSink interface + context helpers
- `backend/internal/service/llm/tools/display_result.go` — DisplayResultPayload type

## Files to Modify

- `backend/internal/service/llm/tools/builder.go` — Add `WithBashTool()` method
- `backend/internal/service/llm/streaming/tool_registry_factory.go` — Wire bash tool in `BuildProductionRegistry()`
- `backend/internal/service/llm/streaming/tool_registry_factory.go` — Add SandboxService + DatasetService to deps

## Interface Contracts

```go
// OutputSink — generic, any tool can use
type OutputSink interface {
    EmitToolOutput(stream string, text string, seq int)
    EmitDisplayResult(result DisplayResultPayload)
    SendBinary(meshID string, data []byte)
}

// BashTool.Execute routes to ExecBash or ExecInKernel
func (t *BashTool) Execute(ctx context.Context, input map[string]interface{}) (interface{}, error)
```

## Dependencies

- Requires: Phase 1 (sandbox.Service interface)
- Produces: OutputSink interface (Phase 3 implements the emitter bridge)
- Independent of: Frontend phases, dataset domain

## Patterns to Follow

- Tool registration: `backend/internal/service/llm/tools/builder.go` → `WithWebSearch()` pattern
- Tool implementation: `backend/internal/service/llm/tools/web_search.go`
- Error handling: `backend/internal/service/llm/tools/errors.go` → `ErrorResult()`
- Context injection: follow existing `InjectThreadContext` pattern

## Constraints

- OutputSink is extracted from context — tool does NOT hold emitter reference (Decision D1)
- Python detection via `isPythonExecution()` — match `python3`, `python` prefixes
- result_helper.py wrapper code injected for kernel execution
- `_results.clear()` before user code, `_flush()` after (persistent kernel pattern)
- Result file cleanup after reading
- Do NOT implement the OutputSink→emitter bridge (that's Phase 3)
- For this phase, OutputSink can be nil in tests (null-safe checks throughout)

## Verification Criteria

- [ ] `make build` passes
- [ ] Unit tests: bash command routes to `ExecBash`
- [ ] Unit tests: `python3 script.py` routes to `ExecInKernel`
- [ ] Unit tests: result.json parsing + display result emission
- [ ] Unit tests: mesh binary reading + SendBinary call
- [ ] Tool registers via `WithBashTool()` (nil-guard for missing sandbox service)
- [ ] `make test` passes

## Agent Staffing

- **Implementer**: `coder` (backend Go)
- **Reviewer**: 1x reviewer (correctness — Python detection edge cases, result parsing)
- **Verifier**: `verifier`
