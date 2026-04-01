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

## D4: Frontend target — ship on `frontend/` (production app)
**When**: Design review round 1 (2026-04-01)
**What**: All frontend components target `frontend/`, not `frontend-v2/`.
**Why**: `frontend/` has working SSE, WS, stores, panels, and auth. `frontend-v2/` is explicitly "data-last" with no data integration (Phase 7+). Building on v2 would require pulling data integration forward — unnecessary risk for MVP.
**Rejected**: `frontend-v2/` — not data-integrated, would delay MVP.
**Reviewers**: p754 (finding #4)

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
