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

## D13: Review fixes — tool category ordering, upload error handling, BONE_COLORS dedup
**When**: Review synthesis round 2 (2026-04-01)
**What**: Three fixes from p757 SOLID review: (1) Python tool category check must appear before bash check in `getToolCategory()` — `execute_python` segments include "execute", which matches the bash candidates. (2) Upload orchestration wrapped in try/catch with `store.setError()` call. (3) `BONE_COLORS` defined once in `features/viewer-3d/constants.ts`, imported by viewer store instead of duplicated. Also fixed: ContentToolbar properly destructures `activeProjectId` and `viewerMeshId` from store selector (was referencing undefined variables), and PythonOutputBlock auto-collapse uses ref to avoid re-collapsing after user manually expands.
**Why**: H1 was a silent misclassification that would route `execute_python` to the bash detail renderer. M1 left upload failures unhandled — the UI would freeze in uploading state. M2 would be a runtime error.
**Reviewers**: p757 (opus, SOLID/design quality)
**Superseded**: D13.1 — the tool category ordering fix is no longer needed. The bash tool is named "bash", which directly matches the existing bash category. No ordering ambiguity.

---

## D14: Replace execute_python with bash tool
**When**: Architecture revision (2026-04-02)
**What**: The AI uses a generic `bash` ToolExecutor instead of a dedicated `execute_python` tool. The bash tool runs any shell command in the Daytona sandbox. Python scripts are detected and routed through the persistent Jupyter kernel for variable persistence.
**Why**: User requirement — the AI should use bash to write Python files to the filesystem, then run scripts that import them. This is more natural (models already know bash tool patterns), more general (can also install packages, manage files, run non-Python commands), and creates a cleaner extensibility path for code fence execution (option 2). The same `ExecInKernel` interface serves both the bash tool (option 1) and the future code fence interceptor (option 2).
**Rejected**: (a) Keeping `execute_python` — too narrow, AI can't do file management or package installs without a second tool. (b) Two tools (bash + execute_python) — redundant, adds tool-choice complexity for the AI. (c) Pure bash without kernel — no variable persistence between Python executions.

## D15: Generic display results instead of Python-specific events
**When**: Architecture revision (2026-04-02)
**What**: Replace `PYTHON_OUTPUT`/`PYTHON_RESULT` AG-UI events with generic `TOOL_OUTPUT`/`DISPLAY_RESULT`. Any tool can emit display results. The concept is decoupled from the bash tool and from Python.
**Why**: User requirement — display results are a generic concept. The same chart/table/image rendering should work regardless of which tool produced the output. This also supports the extensibility requirement: when code fence execution (option 2) replaces the bash tool trigger, the downstream DISPLAY_RESULT events and frontend rendering are unchanged.
**Rejected**: Keeping Python-specific events — ties the frontend to a specific tool implementation, requires changes when the trigger mechanism changes.

## D16: ActivityBlock model — all work collapses, results punch out
**When**: Architecture revision (2026-04-02)
**What**: One ActivityBlock per assistant turn. ALL work (thinking, tool calls, text between tool calls) collapses inside a card. Display results render outside the card, always visible. Final response text is always visible. This is the general model — not Python-specific.
**Why**: User requirement. The researcher's primary need is seeing results (charts, 3D models, tables) and the AI's conclusion. The execution details (which commands ran, what stdout said) are secondary — useful for debugging but shouldn't dominate the view. The existing ActivityBlock already promotes the last ContentItem outside the card; DisplayResultItems follow the same pattern.
**Supersedes**: D10 (which described the same concept but with Python-specific terminology).

## D17: Persistent Jupyter kernel for variable persistence
**When**: Architecture revision (2026-04-02)
**What**: The Daytona sandbox runs a Jupyter kernel gateway. The `ExecInKernel` method sends Python code to this kernel, where variables and imports persist between calls. Regular bash commands bypass the kernel.
**Why**: User requirement — "persistent Jupyter kernel — variables and imports survive between executions." The AI writes utility modules to .py files (filesystem persistence) and executes scripts through the kernel (runtime persistence). When the sandbox stops and restarts, the filesystem survives but kernel state is lost — the AI re-imports modules on first call.
**Rejected**: (a) Fresh Python process per execution — no variable persistence. (b) IPython with %store magic — fragile, requires manual state management. (c) Pickling session state — complex, not all objects are picklable.

## D18: Extensibility design for code fence execution
**When**: Architecture revision (2026-04-02)
**What**: The execution path is designed with a clean interface boundary between trigger mechanism and downstream pipeline. The bash tool calls `sandboxSvc.ExecInKernel()` + `OutputSink.EmitDisplayResult()`. A future code fence interceptor would call the same interfaces. The Daytona service, result_helper.py protocol, DISPLAY_RESULT events, and frontend rendering are all decoupled from how code arrives.
**Why**: User requirement — "the downstream flow must be identical regardless of trigger mechanism." By making the interfaces generic now, the future migration from bash tool (option 1) to code fence interceptor (option 2) only changes the trigger layer, not the execution or rendering layers.
**Constraint**: The code fence interceptor needs access to the same `sandboxSvc` and `OutputSink`. The `StreamExecutor` must make these available to the interceptor layer when it's built.

## D19: TOOL_CALL_END event ordering — AG-UI protocol compliance
**When**: Correctness review (2026-04-02), reviewer p760 (opus)
**What**: Corrected event ordering spec. `TOOL_CALL_END` fires when the LLM finishes streaming the tool_use block — **before** tool execution starts, not after. The correct order is: `TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END → TOOL_OUTPUT → DISPLAY_RESULT → TOOL_CALL_RESULT`.
**Why**: `TOOL_CALL_END` is an AG-UI protocol event generated by the SSE library during response parsing. The backend has no `EmitToolCallEnd` method — it's not under our control. The original spec incorrectly placed it after TOOL_OUTPUT, which would require intercepting AG-UI library events (protocol-breaking). The existing reducer already transitions tool status to `"executing"` on TOOL_CALL_END.
**Corrected**: `display-results.md` and `activity-stream.md` event ordering sections, Storybook scenario event sequence.

## D20: WS binary frame dispatch — routing collision with Yjs
**When**: Correctness review (2026-04-02), reviewer p760 (opus)
**What**: Added `BinaryDispatch` layer to route WS binary frames. `WsClient.onBinaryMessage` is a single callback — `DocWsProvider` (Yjs) and `ThreadWsProvider` (mesh) both need it. Dispatch routes by `subId`: registered doc subscriptions go to Yjs, everything else goes to mesh handler.
**Why**: Without dispatch, whoever registers `onBinaryMessage` last wins. The other system silently breaks. Worse, Yjs could receive mesh binary data and try to apply it as document updates, potentially corrupting document state.
**Rejected**: (a) Converting `onBinaryMessage` to an array of handlers — requires WsClient interface change. (b) Separate WS connections — unnecessary complexity, doubles connection overhead.

## D21: Bidirectional mesh metadata/binary race handling
**When**: Correctness review (2026-04-02), reviewer p760 (opus)
**What**: Viewer store now handles both orderings: labels-before-binary (normal) and binary-before-labels (race). Binary data arriving before DISPLAY_RESULT is stored in `pendingMeshData` and merged when labels arrive.
**Why**: SSE (DISPLAY_RESULT) and WS (binary frame) travel over separate TCP connections with no cross-transport ordering guarantee. The original design only handled labels-first, causing structures to render as "Structure 1" instead of "femur" when binary arrived first.

## D22: Kernel wrapper — try/finally and sys.path
**When**: Correctness review (2026-04-02), reviewer p760 (opus)
**What**: Kernel wrapper uses `try/finally` around user code to ensure `_flush()` runs even on exceptions. Added `/workspace` and `/workspace/scripts` to `sys.path` so AI-written modules are importable.
**Why**: Without try/finally, partial results from `show_*` calls before a crash are lost. Without sys.path extension, `import seg_utils` fails unless the kernel cwd happens to be right.

---

## D23: Two tools — `python` + `bash` — replacing single bash tool
**When**: Requirements revision (2026-04-04)
**What**: Split the single `bash` ToolExecutor into two separate tools:
- `python` tool: input is raw Python code, always executes in Jupyter kernel, always wrapped with result_helper
- `bash` tool: input is a shell command, for file ops and non-Python tasks, no kernel, no result capture
**Why**: User requirement. The previous design had a single bash tool that auto-detected Python execution via command prefix matching (`python3 script.py`). This was fragile — detection heuristics, file reading indirection, and mixing concerns. Two tools is cleaner: the AI sends raw code to `python` and raw commands to `bash`. The `python` tool is also designed to be replaceable by a code fence interceptor — making it a separate tool with raw code input makes the trigger-agnostic downstream flow natural.
**Supersedes**: D14 (single bash tool with Python detection)
**Rejected**: (a) Single bash tool with detection — fragile heuristics, unnecessary indirection. (b) Three tools (python + bash + file_write) — file_write is redundant with bash.

## D24: Results are inline content, not a separate rendering area
**When**: Requirements revision (2026-04-04)
**What**: DISPLAY_RESULT events render inline in the ActivityBlock, interleaved with text. They are never collapsed by default. They are content, like text — not "outside the block" in a separate area.
**Why**: User requirement. Charts, tables, images, and mesh cards should appear naturally in the conversation flow alongside text. The previous design rendered display results "outside the collapsed ActivityBlock" in a separate section, which created an artificial separation between text and results.
**Supersedes**: D16 (results "punch out" of the block)

## D25: ActivityBlock with per-item collapse defaults
**When**: Requirements revision (2026-04-04)
**What**: One ActivityBlock per turn contains all items. Each item has a per-item collapse default based on its kind and tool category:
- Thinking → collapsed by default
- Tool input/args → collapsed by default
- Tool stdout → depends on tool category (python: uncollapsed, bash: collapsed)
- Tool stderr → hidden by default (click for popup)
- Text content → never collapsed
- Display results (charts, images, tables, mesh cards) → never collapsed, inline with text
Per-tool-category display config (extensible) controls collapse defaults. Each tool category defines default collapse state for input, stdout, stderr. User can toggle any item.
**Why**: User requirement. Different tools have different output profiles. Python stdout (progress updates, data summaries) is useful to see; bash stdout (file listings, install logs) is noise. The extensible config pattern allows new tool categories to register their own defaults without touching ActivityBlock logic.
**Config**: python: input=collapsed, stdout=uncollapsed, stderr=hidden. bash: input=collapsed, stdout=collapsed, stderr=collapsed.

## D26: Multi-mesh 3D scene managed by mesh ID
**When**: Requirements revision (2026-04-04)
**What**: `show_mesh(verts, faces, mesh_id, label, color)` — one mesh per call. Same mesh_id = replace, new mesh_id = add to scene. No per-vertex labels, no label splitting on frontend. User toggles visibility per mesh via checkboxes.
**Why**: User requirement. The previous design sent one blob with per-vertex label arrays, requiring frontend label splitting. The new design is simpler: each `show_mesh()` call is one complete structure with one color. The AI manages the scene through IDs it chooses. This eliminates the frontend `splitByLabel()` function and simplifies the binary frame format (no label bytes).
**Supersedes**: Previous mesh design with per-vertex labels and label_names maps.

## D27: show_mesh() signature change
**When**: Requirements revision (2026-04-04)
**What**: `show_mesh(vertices, faces, mesh_id, label, color)` instead of `show_mesh(vertices, faces, labels, label_names)`. Binary format simplified: vertices + faces only, no per-vertex label array.
**Why**: Direct consequence of D26. Each mesh is one structure. The mesh_id, label, and color are per-mesh metadata sent in the DISPLAY_RESULT event, not per-vertex data in the binary frame.

## D28: stderr hidden by default, click-to-view popup
**When**: Requirements revision (2026-04-04)
**What**: stderr is hidden by default for all tool categories. Available via a click-to-view popup (not inline, not collapsed). A small badge appears on the tool row when stderr exists.
**Why**: User requirement. stderr is usually noise — deprecation warnings, progress bars, library chatter. When there IS an error, the tool result status shows the failure. stderr is available for debugging but shouldn't clutter the output. A popup is the right interaction: available on demand, invisible by default.

---

## D29: Unified filesystem — text in DB, binary in bucket, metadata unifies
**When**: Filesystem redesign (2026-04-05)
**What**: All files get a row in the `documents` table with a `storage_type` field (`text` or `binary`). Text file content stays in the DB `content` column (Yjs state already lives there). Binary file content goes to a Supabase Storage bucket. The metadata layer (documents table) provides one unified project tree regardless of where content lives.
**Why**: The research platform handles arbitrary files — DICOM stacks, Python scripts, meshes, PDFs. The fiction-era assumption "file = markdown with content in DB" doesn't scale. The user's insight is correct: text files already have their content in DB via Yjs, so forcing them into a bucket would add sync complexity for no benefit. Binary files are too large for TEXT columns. The split is natural along the line that already exists.
**Rejected**: (a) All files in bucket — forces sync between bucket and DB for Yjs collab state. Adds latency and consistency problems for text editing. (b) All files in DB — DICOM stacks can be hundreds of MB, inappropriate for TEXT columns. (c) Virtual filesystem (FUSE/WebDAV) — adds infrastructure complexity without clear benefit for MVP.
**Constraint**: Supabase is already committed (upgrading to Pro). Must support files up to ~500MB. Collab (Yjs) must keep working for text files without changes.

## D30: StorageType as allowlist — unknown extensions default to binary
**When**: Filesystem redesign (2026-04-05)
**What**: `StorageTypeFromExtension()` uses an allowlist of text extensions. Any extension not in the list defaults to `StorageTypeBinary`. This is the single routing function that determines where content lives.
**Why**: Binary is the safe default. An unknown extension stored as text could mean gigabytes in a TEXT column (e.g., someone uploads a `.dat` file). An unknown extension stored in a bucket always works — the metadata row still exists for tree navigation. The allowlist grows as we add support for new text-editable formats.
**Rejected**: (a) Blocklist of binary extensions — open-ended, can't anticipate all binary formats. A missed extension means data in a TEXT column. (b) MIME type sniffing — requires reading file content before deciding storage location, adds complexity to the upload flow. (c) User choice — adds UI friction and users don't know or care about storage routing.

## D31: Dataset domain collapses into filesystem
**When**: Filesystem redesign (2026-04-05)
**What**: The separate `datasets` domain (designed in Phase 4 of the MVP) is eliminated. A DICOM dataset is a folder with `Metadata["dataset"]` JSONB containing status, modality, scanner info. Upload uses the same bulk file upload endpoints. Metadata extraction runs on finalize.
**Why**: Datasets are just folders of binary files with metadata. Having two parallel file systems (docsystem for text, datasets for binary) is architecturally wrong — it means two tree views, two upload flows, two delete cascades, two authorization checks. The unified filesystem handles both text and binary files, so datasets become a folder pattern, not a domain.
**Eliminated**: ~500 lines of code: `domain/datasets/`, `service/datasets/`, `handler/dataset.go`, `repository/postgres/dataset.go`, `create_datasets` migration.
**Replaced by**: `Folder.Metadata["dataset"]` JSONB + bulk upload endpoints + DICOM metadata extractor.

## D32: ISP split (Reader/Writer/Searcher/PathResolver) survives and strengthens
**When**: Filesystem redesign (2026-04-05), from docsystem audit (p768)
**What**: The existing ISP interface split on DocumentStore is kept. The Reader/Writer/Searcher/PathResolver separation becomes *more* valuable with binary files — a component that only reads metadata doesn't need to know about bucket storage.
**Why**: The split was designed for SRP: different consumers need different subsets of document operations. With binary files, the split also provides isolation: the collab domain depends on DocumentReader (which never touches buckets), not DocumentStore. DocumentWriter stays DB-only; bucket cleanup is orchestrated at the service layer (DocumentService.DeleteDocument).
**Rejected**: (a) Collapsing into a single interface — loses the SRP benefit and forces all consumers to accept the bucket storage dependency. (b) New parallel interfaces for binary files — creates the same duplication problem as the datasets domain.

## D33: file_type column kept for backwards compatibility during migration
**When**: Filesystem redesign (2026-04-05)
**What**: The `file_type` column (with values markdown/skill/agent/tool/excalidraw/mermaid/image/pdf) stays in the schema temporarily. New code uses `storage_type` + `mime_type`. The old column can be dropped in a cleanup migration after all queries are migrated.
**Why**: The file_type column has a CHECK constraint and is referenced by queries across handlers, services, and repositories. Dropping it atomically with the filesystem migration risks breaking existing functionality. A phased approach (add storage_type → migrate queries → drop file_type) is safer.
**Constraint discovered**: The file_type CHECK constraint (`CHECK (file_type IN (...))`) must be dropped before any binary files can be created, since binary DICOM files don't fit the existing enum. The migration must drop this constraint even if the column stays.

## D34: Sandbox file access — Direct S3 API, not FUSE mount
**When**: Filesystem redesign (2026-04-05)
**What**: Daytona sandbox accesses Supabase Storage files via boto3 (S3-compatible API) with credentials injected as environment variables. For bulk DICOM processing, files are pre-staged to the sandbox via copy-on-start. FUSE mount rejected.
**Why**: DICOM processing involves heavy seek operations (reading metadata at specific offsets, then pixel data). FUSE on object storage has 5–100× latency for random-access seeks because each seek triggers an HTTP range request. Deepnote documents this same problem (recommending users copy files to `/tmp` before processing). Jupyter cloud deployments have the same "path gap" pain point. Direct S3 API gives explicit control over what's downloaded and when.
**Rejected**: (a) FUSE mount (Daytona Volumes) — seek latency unacceptable for DICOM. Would need benchmarking before adoption. Also unclear whether Daytona volumes support custom S3 endpoints (they use Daytona's own storage). (b) Virtual filesystem (WebDAV) — adds infrastructure, same latency issues. (c) Backend API proxy — unnecessary indirection when S3 API works directly.
**Evidence**: Platform research (Deepnote §2, Google Colab §3 in platform-storage-patterns.md), Supabase Storage research (§9 in supabase-storage-capabilities.md).

## D35: Upload protocol — TUS resumable for browser, S3 multipart for backend
**When**: Filesystem redesign (2026-04-05)
**What**: Browser uploads > 6 MB use TUS resumable protocol (24-hour resume window, 6 MB chunks). Go backend uploads use AWS SDK v2 S3 multipart (parallel chunks with automatic retry). Small browser uploads (≤ 6 MB) use standard PUT to signed URL.
**Why**: TUS is the optimal browser protocol — Supabase implements it natively, tus-js-client handles retry/resume, and the 24-hour window covers interrupted DICOM stack uploads. S3 multipart is the optimal server-side protocol — AWS SDK v2 handles chunking, parallelization, and retry transparently.
**Rejected**: (a) Standard upload for all sizes — no resumability, full restart on interruption for large files. (b) TUS for backend uploads — unnecessary complexity when S3 multipart works better server-side. (c) Custom chunked upload protocol — why reinvent TUS.
**Constraint discovered**: TUS chunk size is hardcoded at 6 MB by Supabase — cannot be changed. Only one active client per upload URL (concurrent uploads to same URL get 409 Conflict).

## D36: Go SDK — AWS SDK v2 for uploads, storage-go for admin
**When**: Filesystem redesign (2026-04-05)
**What**: Use AWS SDK v2 (via S3-compatible endpoint) for file upload/download operations. Use supabase-community/storage-go for administrative operations (bucket management, signed URL generation).
**Why**: The storage-go library (v0.7.0, October 2023) doesn't implement TUS or multipart uploads — insufficient for large binary files. AWS SDK v2 is actively maintained, provides multipart upload via `s3manager.Uploader`, and works with Supabase's S3-compatible endpoint. storage-go is adequate for simple operations like `CreateSignedUrl`.
**Rejected**: (a) storage-go only — no multipart upload support, 18+ months stale. (b) AWS SDK v2 only — signed URL generation is simpler via storage-go's purpose-built methods. (c) Raw HTTP + TUS client — more code, less battle-tested than AWS SDK v2.
