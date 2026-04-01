# Phase 9: End-to-End Integration

**Round 5** — Depends on all previous phases.

## Scope

Wire everything together and verify the full pipeline works end-to-end: upload DICOM → select data-analyst agent → execute Python → see results in chat → validate 3D model.

## Intent

Individual phases are verified in isolation. This phase verifies they compose correctly. It's primarily wiring, configuration, and testing — minimal new code.

## Files to Modify

- `backend/internal/app/domains/` — Verify all domain modules are wired
- `backend/internal/service/llm/tools/builder.go` — Verify execute_python registration with real dependencies
- `backend/internal/service/llm/streaming/tool_executor.go` — Verify PYTHON_OUTPUT/PYTHON_RESULT events flow through persistence
- Frontend stores/providers — Verify binary mesh frames route to viewer
- `.env.example` / `.env` — Add Daytona credentials for integration testing

## Key Integration Points

1. **Tool → Sandbox → Stream**: execute_python calls sandboxSvc.ExecStream(), which calls emitter.EmitPythonOutput() — verify this chain works
2. **Result → TurnBlock → Frontend**: PythonResult events are persisted as TurnBlocks and also streamed — verify both paths
3. **Binary mesh → WS → Viewer**: Mesh binary frame from backend → ThreadWsProvider onBinaryMessage → UI store → Viewer3DPanel
4. **Dataset → Sandbox**: Upload DICOM via API → hydrate into sandbox → Python code reads from `/workspace/datasets/`
5. **Agent → Tool**: data-analyst persona selects execute_python; tool filter excludes other tools

## Verification Criteria

- [ ] Full pipeline smoke test: upload DICOM, ask agent to load and display a slice, see matplotlib output in chat
- [ ] Agent uses execute_python tool when asked to process data
- [ ] Streaming stdout appears in real-time during long computations
- [ ] Plotly chart renders interactively in chat
- [ ] DataFrame table renders with proper styling
- [ ] Mesh binary data triggers 3D viewer in right panel
- [ ] Structure toggle works on multi-label mesh
- [ ] Sandbox auto-stops after idle timeout
- [ ] Page reload shows persisted turn blocks (charts, tables, images)

## Agent Staffing

- **Implementer**: `coder` (wiring and configuration fixes)
- **Smoke tester**: `smoke-tester` (end-to-end pipeline verification)
- **Browser tester**: `browser-tester` (visual verification of inline results + 3D viewer)
