# Decisions — Biomedical MVP

## D1: Tool-emitter architecture — OutputSink via context injection
**When**: Design review round 1 (2026-04-01)
**What**: Tools that need to stream intermediate output use an `OutputSink` interface injected into the execution context by `StreamExecutor`. Tools extract it with `OutputSinkFromContext(ctx)`.
**Why**: The existing `ToolExecutor` interface is `Execute(ctx, input) → (result, error)`. Tools don't have emitter access — the emitter is created at stream-execution time, after tools are constructed. No existing tool holds an emitter reference.
**Rejected**: (a) Passing emitter to tool constructor — timing problem, emitter doesn't exist yet. (b) Changing `ToolExecutor` interface to `Execute(ctx, ToolCall) → (result, error)` — too invasive for MVP, breaks all existing tools. (c) Channel-based return — largest interface change, deferred.
**Reviewers**: p752 (opus, SOLID review), p754 (gpt52, implementability review)

## D2: Result protocol — file-based, not stdout sentinel
**When**: Design review round 1 (2026-04-01)
**What**: Python writes results to `/workspace/.meridian/result.json`. Go tool reads the file after execution. No stdout sentinel parsing.
**Why**: Stdout sentinel (`__MERIDIAN_RESULT__...`) is fragile — cross-chunk splitting, user code collision, and mixing data/control on same channel. File-based is clean separation.
**Rejected**: Stdout sentinel — fragile for the reasons above. Writing to a named pipe — unnecessary complexity for synchronous-after-execution reads.
**Reviewers**: p752 (finding #7), p754 (finding #5)

## D3: Mesh transport — file-based write, backend binary send
**When**: Design review round 1 (2026-04-01)
**What**: Python `show_mesh()` writes binary mesh data to `/workspace/.meridian/meshes/{id}.bin`. Go tool reads the file after execution and sends via `OutputSink.SendBinary()`. The sink delegates to WS binary frame sender.
**Why**: Hex-encoding mesh data in JSON (as originally designed) doubles the payload size, exceeding the 10MB guard for typical meshes (50K vertices = ~1.8MB binary, ~3.6MB hex). Direct binary file + WS binary frame is the efficient path.
**Rejected**: (a) Hex-in-stdout — too large. (b) Base64-in-JSON — still 33% inflation. (c) Separate HTTP endpoint for mesh fetch — adds latency and complexity.
**Reviewers**: p752 (finding #2), p753 (finding #1), p754 (finding #5)

## D4: Frontend target — ship on `frontend-v2/` (ground-up rebuild)
**When**: Design revision (2026-04-01)
**What**: All frontend components target `frontend-v2/`, not `frontend/`.
**Why**: `frontend-v2/` has the superior foundation: Storybook-first workflow, modern activity stream reducer (discriminated union events + immutable state), existing tool detail routing, shadcn/ui atoms, Tailwind v4, React 19. The data integration gap (Phase 7+) becomes an opportunity — build the data layer fresh with biomedical needs in mind rather than retrofitting v1 patterns. The biomedical MVP builds layouts (v2 Phase 6), stores (v2 Phase 7), and minimal routing (v2 Phase 8) scoped to what the research workflow needs.
**Rejected**: `frontend/` (v1) — has working infrastructure but the SSE handler architecture, zustand store shape, and panel system don't match v2's cleaner event-driven model. Building on v1 means eventual migration cost.
**Supersedes**: Original D4 which targeted `frontend/`. Reversed after user decision.
**Reviewers**: p754 (finding #4 identified the ambiguity)

## D5: Registration pattern — `WithExecutePython()` builder method
**When**: Design review round 1 (2026-04-01)
**What**: Register execute_python via `builder.WithExecutePython(sandboxSvc, datasetSvc)`, called from `ToolRegistryFactory.BuildProductionRegistry()`. Nil-guard on sandboxSvc for graceful degradation.
**Why**: The existing builder uses fluent `With*` methods (`WithWebSearch`, `WithSpawnTool`), not `toolSet` map checks. Following the established pattern.
**Rejected**: Direct `toolSet` map check — not how the builder works.
**Reviewers**: p752 (finding #3), p754 (finding #2)

## D6: Concurrency — singleflight.Group for EnsureRunning
**When**: Design review round 1 (2026-04-01)
**What**: Use `singleflight.Group` keyed by project ID instead of a global `sync.Mutex`.
**Why**: Global mutex blocks all projects when one is booting (2-5 seconds). singleflight deduplicates concurrent requests for the same project and allows different projects to proceed independently.
**Reviewer**: p752 (finding #4)

## D7: Dataset auth — userID on all service methods
**When**: Design review round 1 (2026-04-01)
**What**: All dataset service methods accept `userID` for authorization checks, matching existing domain service patterns.
**Why**: Without userID, authenticated users could access any project's datasets by ID. Existing pattern (DocumentService, FolderService) always passes userID.
**Reviewer**: p752 (finding #5)

## D8: DataFrame HTML — sanitize with DOMPurify
**When**: Design review round 1 (2026-04-01)
**What**: DataFrameBlock sanitizes HTML via DOMPurify with strict allowlist (table tags only).
**Why**: Even though `df.to_html(escape=True)` should be safe, the sandbox/LLM can emit arbitrary HTML. Defense in depth.
**Reviewer**: p754 (finding C)

## D9: Mesh binary parsing — copy to aligned buffers

**When**: Design review round 1 (2026-04-01)
**What**: Frontend mesh parser copies vertex/face data into fresh aligned ArrayBuffers before constructing Float32Array/Uint32Array views.
**Why**: If the mesh_id prefix leaves the payload at a non-4-byte-aligned offset, typed array constructors throw RangeError. Copying ensures alignment.
**Reviewer**: p753 (finding #2)

## D10: Activity stream integration — ResultItem for rich results, ToolItem for stdout
**When**: Design revision for v2 (2026-04-01)
**What**: `PYTHON_OUTPUT` events accumulate on the ToolItem's `pythonOutput` field (rendered in PythonDetail when expanded). `PYTHON_RESULT` events create new `ResultItem` entries in the activity items array that render as always-visible blocks outside the collapsible ActivityBlock card.
**Why**: Stdout/stderr is verbose and tool-scoped — it belongs inside the collapsible tool detail. Rich results (charts, tables, images, mesh refs) are the primary output the researcher needs to see — they must be visible without expanding the tool. The v2 ActivityBlock already promotes the last ContentItem outside the card; ResultItems follow the same pattern.
**Rejected**: (a) All in ToolItem — hides rich results behind expand. (b) All as separate ActivityItems — loses association between output and the tool that produced it. (c) Separate rendering path outside ActivityBlock — over-engineering for MVP.
**Constraint**: v2's ActivityBlock renders items inside a collapsible Card. Only the last ContentItem and ResultItems render outside. This pattern generalizes cleanly for future tool result types.

## D11: Workspace layout — react-resizable-panels, desktop-only
**When**: Design revision for v2 (2026-04-01)
**What**: Two-panel workspace using `react-resizable-panels`. Chat left (45% default), content right (55% default). Content panel switches between 3D viewer, dataset browser, and editor. Desktop-only (min 1024px).
**Why**: The biomedical workflow is inherently desktop — researchers use large monitors for imaging data. Mobile layout adds complexity with zero user value. `react-resizable-panels` is already a Phase 6 dependency in v2's roadmap and integrates cleanly with the existing component tree.
**Rejected**: (a) CSS Grid layout — no resize handles. (b) Custom splitter — react-resizable-panels is well-maintained and handles edge cases (min/max sizes, persistence). (c) Responsive mobile layout — not needed for single-user MVP.

## D12: State management — zustand for client state, TanStack Query for server state
**When**: Design revision for v2 (2026-04-01)
**What**: Workspace panel state, viewer mesh data, and upload progress use zustand stores. Dataset lists and metadata use TanStack Query. Thread streaming uses the existing reducer + useSyncExternalStore pattern.
**Why**: Clear separation: zustand for client-only ephemeral state (what panel is showing, mesh in memory, upload progress), TanStack Query for server-cached state (dataset list, metadata). The existing streaming infrastructure already works well — no need to replace it with zustand.
**Rejected**: (a) All zustand — would need manual cache invalidation for server data. (b) All TanStack Query — awkward for transient client state like upload progress and mesh binary data. (c) Context API — causes unnecessary re-renders for frequently-changing state like upload progress.
