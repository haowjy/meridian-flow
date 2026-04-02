# Phase 10: End-to-End Integration

**Round 5** — Depends on all previous phases.

## Scope

Wire everything together and verify the full pipeline works end-to-end in `frontend-v2/`: upload DICOM → select data-analyst agent → execute Python → see results in chat → validate 3D model.

## Intent

Individual phases are verified in isolation (Storybook for frontend, unit tests for backend). This phase verifies they compose correctly with real data flowing through the full stack. Primarily wiring, configuration, and testing — minimal new code.

## Files to Modify

- `backend/internal/app/domains/` — Verify all domain modules are wired
- `backend/internal/service/llm/tools/builder.go` — Verify execute_python registration with real dependencies
- `backend/internal/service/llm/streaming/tool_executor.go` — Verify OutputSink injection and PYTHON_OUTPUT/PYTHON_RESULT event flow
- `frontend-v2/src/features/threads/streaming/ThreadWsProvider.tsx` — Verify binary mesh frame routing
- `frontend-v2/src/features/workspace/ContentPanel.tsx` — Verify all content types wire correctly
- `frontend-v2/src/stores/` — Verify store interactions (viewer ↔ workspace, dataset ↔ workspace)
- `.env.example` / `.env` — Add Daytona credentials for integration testing

## Key Integration Points

1. **Tool → Sandbox → Stream**: execute_python calls sandboxSvc.ExecStream(), OutputSink emits PYTHON_OUTPUT — verify chain
2. **Result → TurnBlock → Frontend**: PythonResult events are persisted as TurnBlocks AND streamed via SSE — verify both paths
3. **Binary mesh → WS → Store → Viewer**: Backend binary frame → WsClient.onBinaryMessage → parseMeshBinary → viewerStore → workspaceStore.showViewer → Viewer3DPanel
4. **Dataset → Sandbox**: Upload DICOM via API → hydrate into sandbox → Python code reads from `/workspace/datasets/`
5. **Agent → Tool**: data-analyst persona selects execute_python; tool filter includes it

## Minimal Routing

Add basic routing so the app can load a project and thread:

```typescript
// Minimal TanStack Router setup
const rootRoute = createRootRoute()
const projectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/projects/$projectId",
  component: WorkspaceLayout,
})
```

Full routing design is out of scope — this is enough to load the workspace with a real project.

## Auth Wiring

Connect the WsClient and API client to a real auth token:
- Dev: `scripts/get-token.sh` output injected as env var
- The WsClient already handles auth via `getToken` config
- The API client from Phase 5 uses the same token provider

## Verification Criteria

- [ ] Full pipeline smoke test: upload DICOM, ask agent to load and display a slice, see matplotlib output in chat
- [ ] Agent uses execute_python tool when asked to process data
- [ ] Streaming stdout appears in real-time during long computations
- [ ] Plotly chart renders interactively in chat
- [ ] DataFrame table renders with proper styling and sanitization
- [ ] Mesh binary data triggers 3D viewer in right panel
- [ ] Structure toggle works on multi-label mesh
- [ ] Sandbox auto-stops after idle timeout
- [ ] Page reload shows persisted turn blocks (charts, tables, images)
- [ ] MeshRefBlock shows "unavailable" state after page reload (binary data is transient)
- [ ] Dataset list refreshes after upload finalize

## Agent Staffing

- **Implementer**: `coder` (wiring and configuration fixes)
- **Smoke tester**: `smoke-tester` (end-to-end pipeline verification)
- **Browser tester**: `browser-tester` (visual verification of inline results + 3D viewer)
