# Phase 3: execute_python ToolExecutor

**Round 2** — Depends on Phase 1 (Daytona service).

## Scope

Implement the `execute_python` ToolExecutor that wraps the Daytona sandbox service. Register it in the tool registry. Includes the result_helper.py module and the runner template.

## Intent

This is the core tool the data-analyst agent uses. It takes Python code, writes it to the sandbox, executes it, streams stdout/stderr, and parses rich results. This phase connects the sandbox service to the LLM tool pipeline.

## Files to Create

- `backend/internal/service/llm/tools/execute_python.go` — ToolExecutor implementation
- `backend/internal/service/llm/tools/execute_python_meta.go` — ToolMetadata
- `backend/internal/service/llm/tools/execute_python_test.go` — Unit tests
- `backend/internal/service/llm/tools/output_sink.go` — OutputSink interface + context helpers
- `backend/internal/service/llm/tools/testdata/result_helper.py` — Embedded helper module

## Files to Modify

- `backend/internal/service/llm/tools/builder.go` — Add `WithExecutePython()` fluent method
- `backend/internal/service/llm/streaming/tool_registry_factory.go` — Wire sandbox + dataset services into factory deps, call `WithExecutePython()`

## Interface Contract

```go
type ExecutePythonTool struct {
    sandboxSvc  sandbox.Service
    datasetSvc  datasets.Service
    projectID   uuid.UUID
    userID      uuid.UUID
    threadID    uuid.UUID
    emitter     *agui.Emitter
}

// Input schema for LLM:
// { "code": string, "timeout_seconds": int (optional, default 120, max 600) }

// Output to LLM:
// { "success": bool, "output": string, "results": [...], "error": string }
```

## Key Implementation Details

1. **OutputSink interface**: Define `OutputSink` with `EmitOutput()`, `EmitResult()`, `SendBinary()`. Context injection helpers. See design/backend/execute-python.md §Architecture Constraint.
2. **Runner template**: Wraps user code with result_helper imports and `atexit.register(_flush)`.
3. **File-based results**: After execution, read `/workspace/.meridian/result.json` via `sandboxSvc.ReadFile()`. Parse JSON array.
4. **Streaming stdout**: Uses `sandboxSvc.ExecStream()` with callback. If `OutputSink` in context, call `sink.EmitOutput()`.
5. **Mesh handling**: For mesh results, read binary file from `bin_path`, call `sink.SendBinary(meshID, data)`.
6. **Registration**: `WithExecutePython(sandboxSvc, datasetSvc)` fluent method on builder, nil-guard on sandboxSvc.
7. **Timeout**: Configurable per call, capped at 600 seconds.

## Dependencies

- Requires: Phase 1 (sandbox.Service interface)
- Requires: Phase 2 (datasets.Service for file path resolution) — soft dependency, can stub initially
- Produces: Tool available for Phase 5 (agent profile) and Phase 4 (stream extensions)

## Patterns to Follow

- Tool implementation: `backend/internal/service/llm/tools/text_editor.go` (struct, constructor, Execute, metadata)
- Registration: `backend/internal/service/llm/tools/builder.go` lines where tools are conditionally registered
- Error handling: Return `ErrorResult()` maps for LLM consumption
- Provenance: `tools.InjectThreadContext()` for tracking

## Verification Criteria

- [ ] `make build` passes
- [ ] `make test` passes (mock sandbox service, verify code wrapping and result parsing)
- [ ] Tool registers successfully when sandbox config is present
- [ ] Tool is excluded when sandbox config is absent (graceful degradation)
- [ ] Result parsing handles: no results, single result, multiple results, malformed output
- [ ] Timeout enforcement works (mock long-running process)

## Agent Staffing

- **Implementer**: `coder` -m codex (backend Go, follows existing patterns closely)
- **Reviewer**: 1x reviewer with correctness focus (result parsing is tricky — edge cases with binary in stdout, encoding)
- **Verifier**: `verifier`
