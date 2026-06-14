# Exploration Report: Work Items, Spawning, and Context Management

## Scope and method

- Exploration-only pass; no implementation changes were made.
- Read all files in relevant directories (`read_files=144`) across:
  - `backend/internal/domain/workitem`
  - `backend/internal/service/workitem`
  - `backend/internal/repository/postgres/workitem`
  - `backend/internal/service/llm/streaming`
  - `backend/internal/service/llm/tools`
  - `backend/internal/domain/llm`
  - `backend/internal/repository/postgres/llm`
  - `backend/internal/handler`
- Also reviewed migrations and key tests to validate intent and edge-case behavior.
- Session rationale mined from parent transcript (`$MERIDIAN_CHAT_ID`) via:
  - `meridian session search "spawn_depth" ...`
  - `meridian session search "ephemeral cap" ...`
  - `meridian session search "collapsed_content" ...`

---

## 1) WorkItem domain type

### Status lifecycle (active/done)

- Domain enum only allows `active` and `done`; delete is explicitly **not** a status transition ([backend/internal/domain/workitem/types.go:5](backend/internal/domain/workitem/types.go:5), [backend/internal/domain/workitem/types.go:11](backend/internal/domain/workitem/types.go:11), [backend/internal/domain/workitem/types.go:12](backend/internal/domain/workitem/types.go:12)).
- Transition intent documented as `active -> done` and `done -> active` ([backend/internal/domain/workitem/types.go:6](backend/internal/domain/workitem/types.go:6)).

### Soft delete

- `DeletedAt *time.Time` is part of the aggregate and used to hide rows from standard queries ([backend/internal/domain/workitem/types.go:31](backend/internal/domain/workitem/types.go:31)).
- DB enforces this model via partial indexes scoped to `deleted_at IS NULL` ([backend/migrations/00034_create_work_items.sql:33](backend/migrations/00034_create_work_items.sql:33)).

### Ephemeral items

- First-class field `IsEphemeral bool` in domain entity and create request ([backend/internal/domain/workitem/types.go:25](backend/internal/domain/workitem/types.go:25), [backend/internal/domain/workitem/types.go:54](backend/internal/domain/workitem/types.go:54)).
- Backed by indexed predicates for project-level cap checks ([backend/migrations/00034_create_work_items.sql:43](backend/migrations/00034_create_work_items.sql:43)).

### Slug generation

- Slug is service-owned (caller must not provide), which centralizes naming policy ([backend/internal/domain/workitem/types.go:49](backend/internal/domain/workitem/types.go:49)).

---

## 2) WorkItem service

### Authorization model

- Service enforces membership by looking up project via `projectRepo.GetByID(...)` before exposing or mutating work items ([backend/internal/service/workitem/service.go:63](backend/internal/service/workitem/service.go:63), [backend/internal/service/workitem/service.go:139](backend/internal/service/workitem/service.go:139), [backend/internal/service/workitem/service.go:227](backend/internal/service/workitem/service.go:227)).
- Pattern: fetch entity, then authorize using resolved `ProjectID` where route only has item ID ([backend/internal/service/workitem/service.go:176](backend/internal/service/workitem/service.go:176), [backend/internal/service/workitem/service.go:181](backend/internal/service/workitem/service.go:181)).

### CAS-style updates / conflict handling

- Complete/reopen rely on store-level compare-and-set status update ([backend/internal/service/workitem/service.go:241](backend/internal/service/workitem/service.go:241), [backend/internal/service/workitem/service.go:275](backend/internal/service/workitem/service.go:275)).
- Service maps CAS conflicts into semantic domain errors (`WorkItemDone`, reopen conflict) ([backend/internal/service/workitem/service.go:242](backend/internal/service/workitem/service.go:242), [backend/internal/service/workitem/service.go:276](backend/internal/service/workitem/service.go:276)).
- Complete includes runtime guard against active streaming turns ([backend/internal/service/workitem/service.go:232](backend/internal/service/workitem/service.go:232), [backend/internal/service/workitem/service.go:238](backend/internal/service/workitem/service.go:238)).

### Ephemeral cap enforcement

- Hardcoded cap: `maxActiveEphemerals = 100` ([backend/internal/service/workitem/service.go:24](backend/internal/service/workitem/service.go:24)).
- `EnsureThreadWorkItem` behavior:
  - Existing valid work item ID => no-op ([backend/internal/service/workitem/service.go:379](backend/internal/service/workitem/service.go:379)).
  - Under cap => create new ephemeral ([backend/internal/service/workitem/service.go:399](backend/internal/service/workitem/service.go:399)).
  - At cap => reuse most recent active ephemeral ([backend/internal/service/workitem/service.go:409](backend/internal/service/workitem/service.go:409)).
  - If at-cap lookup returns not found (race), create fallback ephemeral anyway ([backend/internal/service/workitem/service.go:413](backend/internal/service/workitem/service.go:413), [backend/internal/service/workitem/service.go:418](backend/internal/service/workitem/service.go:418)).

### Slug generation and conflict retry

- Generates base slug using shared identifier utility ([backend/internal/service/workitem/service.go:69](backend/internal/service/workitem/service.go:69)).
- Uses `EnsureUniqueSlug` probe loop and retries on insert conflict (TOCTOU race handling) ([backend/internal/service/workitem/service.go:75](backend/internal/service/workitem/service.go:75), [backend/internal/service/workitem/service.go:79](backend/internal/service/workitem/service.go:79), [backend/internal/service/workitem/service.go:99](backend/internal/service/workitem/service.go:99)).

---

## 3) WorkItem store (Postgres)

### Query model and soft-delete discipline

- All standard reads include `deleted_at IS NULL` ([backend/internal/repository/postgres/workitem/store.go:107](backend/internal/repository/postgres/workitem/store.go:107), [backend/internal/repository/postgres/workitem/store.go:127](backend/internal/repository/postgres/workitem/store.go:127)).
- `SoftDelete` is a single update over non-deleted rows ([backend/internal/repository/postgres/workitem/store.go:262](backend/internal/repository/postgres/workitem/store.go:262)).

### Partial unique index reliance

- Store create path expects DB duplicate errors from partial unique slug index and maps to domain conflict ([backend/internal/repository/postgres/workitem/store.go:61](backend/internal/repository/postgres/workitem/store.go:61), [backend/internal/repository/postgres/workitem/store.go:90](backend/internal/repository/postgres/workitem/store.go:90)).
- Index defined as unique `(project_id, slug)` where `deleted_at IS NULL` ([backend/migrations/00034_create_work_items.sql:33](backend/migrations/00034_create_work_items.sql:33)).

### RETURNING patterns

- `Create` uses `RETURNING` full column set to populate canonical persisted object ([backend/internal/repository/postgres/workitem/store.go:72](backend/internal/repository/postgres/workitem/store.go:72)).
- `Update` uses `RETURNING updated_at` because trigger owns timestamp ([backend/internal/repository/postgres/workitem/store.go:195](backend/internal/repository/postgres/workitem/store.go:195), [backend/internal/repository/postgres/workitem/store.go:207](backend/internal/repository/postgres/workitem/store.go:207)).

### CAS status transition

- `UpdateStatus` does atomic `WHERE id = ? AND status = ? AND deleted_at IS NULL` ([backend/internal/repository/postgres/workitem/store.go:227](backend/internal/repository/postgres/workitem/store.go:227), [backend/internal/repository/postgres/workitem/store.go:234](backend/internal/repository/postgres/workitem/store.go:234)).
- On `RowsAffected()==0`, store checks existence to distinguish not-found vs wrong-state conflict ([backend/internal/repository/postgres/workitem/store.go:243](backend/internal/repository/postgres/workitem/store.go:243), [backend/internal/repository/postgres/workitem/store.go:245](backend/internal/repository/postgres/workitem/store.go:245), [backend/internal/repository/postgres/workitem/store.go:464](backend/internal/repository/postgres/workitem/store.go:464)).

---

## 4) WorkItem handler (REST + DTO mapping)

### API shape

- Routes are project-scoped and slug-addressed for item operations ([backend/internal/handler/work_item.go:13](backend/internal/handler/work_item.go:13), [backend/internal/app/domains/workitem.go:40](backend/internal/app/domains/workitem.go:40)).
- Endpoints:
  - `POST /api/projects/{id}/work-items` ([backend/internal/handler/work_item.go:103](backend/internal/handler/work_item.go:103))
  - `GET /api/projects/{id}/work-items` ([backend/internal/handler/work_item.go:136](backend/internal/handler/work_item.go:136))
  - `GET /api/projects/{id}/work-items/{slug}` ([backend/internal/handler/work_item.go:167](backend/internal/handler/work_item.go:167))
  - `PUT /api/projects/{id}/work-items/{slug}` ([backend/internal/handler/work_item.go:189](backend/internal/handler/work_item.go:189))
  - `POST /api/projects/{id}/work-items/{slug}/complete` ([backend/internal/handler/work_item.go:229](backend/internal/handler/work_item.go:229))
  - `POST /api/projects/{id}/work-items/{slug}/reopen` ([backend/internal/handler/work_item.go:257](backend/internal/handler/work_item.go:257))
  - `DELETE /api/projects/{id}/work-items/{slug}` ([backend/internal/handler/work_item.go:285](backend/internal/handler/work_item.go:285))

### DTO mapping

- Handler maps domain entity into dedicated response DTO, including timestamp string formatting ([backend/internal/handler/work_item.go:51](backend/internal/handler/work_item.go:51), [backend/internal/handler/work_item.go:77](backend/internal/handler/work_item.go:77)).
- Update/transition/delete operations resolve slug -> ID first, then call service by ID ([backend/internal/handler/work_item.go:207](backend/internal/handler/work_item.go:207), [backend/internal/handler/work_item.go:241](backend/internal/handler/work_item.go:241), [backend/internal/handler/work_item.go:297](backend/internal/handler/work_item.go:297)).

---

## 5) SpawnService

### Depth/concurrency limits

- Create flow validates request, loads parent, checks limits, creates child thread, bootstraps stream, waits for completion ([backend/internal/service/llm/streaming/spawn_service.go:71](backend/internal/service/llm/streaming/spawn_service.go:71)).
- Depth limit uses denormalized `spawn_depth` (O(1)); default max=3 when config unset ([backend/internal/service/llm/streaming/spawn_service.go:244](backend/internal/service/llm/streaming/spawn_service.go:244), [backend/internal/service/llm/streaming/spawn_service.go:247](backend/internal/service/llm/streaming/spawn_service.go:247), [backend/internal/service/llm/streaming/spawn_service.go:250](backend/internal/service/llm/streaming/spawn_service.go:250)).
- Concurrent limit per work item counts `spawn_status='running'`; default max=5 ([backend/internal/service/llm/streaming/spawn_service.go:255](backend/internal/service/llm/streaming/spawn_service.go:255), [backend/internal/service/llm/streaming/spawn_service.go:262](backend/internal/service/llm/streaming/spawn_service.go:262), [backend/internal/service/llm/streaming/spawn_service.go:267](backend/internal/service/llm/streaming/spawn_service.go:267)).

### Child thread context inheritance

- Child inherits `work_item_id` from parent thread ([backend/internal/service/llm/streaming/spawn_service.go:113](backend/internal/service/llm/streaming/spawn_service.go:113)).
- DB schema supports spawn lineage and denormalized depth (`parent_thread_id`, `spawn_status`, `spawn_result`, `spawn_depth`) ([backend/migrations/00039_add_thread_spawn_fields.sql:7](backend/migrations/00039_add_thread_spawn_fields.sql:7)).

### ChildThreadBootstrapper

- Bootstraps by creating first user turn on child via standard `CreateTurn` path (inherits prompt/tool/persona pipeline) ([backend/internal/service/llm/streaming/spawn_service.go:359](backend/internal/service/llm/streaming/spawn_service.go:359), [backend/internal/service/llm/streaming/spawn_service.go:386](backend/internal/service/llm/streaming/spawn_service.go:386)).
- Completion detection in v1 is polling via `AuthorizeTurnStream` every 500ms ([backend/internal/service/llm/streaming/spawn_service.go:417](backend/internal/service/llm/streaming/spawn_service.go:417), [backend/internal/service/llm/streaming/spawn_service.go:432](backend/internal/service/llm/streaming/spawn_service.go:432), [backend/internal/service/llm/streaming/spawn_service.go:438](backend/internal/service/llm/streaming/spawn_service.go:438)).

### Running spawn tracking / cancel

- In-memory running set tracked via `activeChildren sync.Map` ([backend/internal/service/llm/streaming/spawn_service.go:37](backend/internal/service/llm/streaming/spawn_service.go:37), [backend/internal/service/llm/streaming/spawn_service.go:132](backend/internal/service/llm/streaming/spawn_service.go:132)).
- `CancelSpawn` attempts executor-level hard cancel through shared registry, then updates DB status ([backend/internal/service/llm/streaming/spawn_service.go:210](backend/internal/service/llm/streaming/spawn_service.go:210), [backend/internal/service/llm/streaming/spawn_service.go:225](backend/internal/service/llm/streaming/spawn_service.go:225), [backend/internal/service/llm/streaming/spawn_service.go:233](backend/internal/service/llm/streaming/spawn_service.go:233)).

---

## 6) SpawnInvoker (circular dependency boundary)

- `SpawnInvoker` is a narrow domain interface (`CreateSpawn`, `GetSpawnStatus`, `CancelSpawn`) used to avoid direct service-cycle coupling ([backend/internal/domain/llm/spawn.go:36](backend/internal/domain/llm/spawn.go:36), [backend/internal/domain/llm/spawn.go:42](backend/internal/domain/llm/spawn.go:42)).
- Wiring pattern in setup:
  - Build streaming service
  - Build spawn service with bootstrapper over streaming service
  - Inject spawn invoker back into streaming service via `SetSpawnInvoker` ([backend/internal/service/llm/setup.go:198](backend/internal/service/llm/setup.go:198), [backend/internal/service/llm/setup.go:201](backend/internal/service/llm/setup.go:201), [backend/internal/service/llm/setup.go:211](backend/internal/service/llm/setup.go:211), [backend/internal/service/llm/setup.go:216](backend/internal/service/llm/setup.go:216)).

---

## 7) ShutdownCoordinator

- Designed as global graceful-shutdown controller with explicit phases: stop admitting new, wait grace period, then force-cancel ([backend/internal/service/llm/streaming/shutdown.go:5](backend/internal/service/llm/streaming/shutdown.go:5), [backend/internal/service/llm/streaming/shutdown.go:111](backend/internal/service/llm/streaming/shutdown.go:111)).
- Tracks active cancel funcs keyed by turn ID with `Register/Deregister` API ([backend/internal/service/llm/streaming/shutdown.go:65](backend/internal/service/llm/streaming/shutdown.go:65), [backend/internal/service/llm/streaming/shutdown.go:86](backend/internal/service/llm/streaming/shutdown.go:86)).

### Observation

- In this snapshot, active stream lifecycle in request path is managed by `executorRegistry` registration in launch flow ([backend/internal/service/llm/streaming/launch_stream.go:135](backend/internal/service/llm/streaming/launch_stream.go:135)).
- I did not find equivalent `ShutdownCoordinator.Register/Deregister` calls in the active launch/create flow. This suggests the coordinator is present but not integrated in current runtime path.

---

## 8) Spawn tool (`spawn_agent`)

### Input validation and error conversion

- Tool validates required `agent` + `prompt` params and trims whitespace ([backend/internal/service/llm/tools/spawn_agent.go:85](backend/internal/service/llm/tools/spawn_agent.go:85), [backend/internal/service/llm/tools/spawn_agent.go:87](backend/internal/service/llm/tools/spawn_agent.go:87), [backend/internal/service/llm/tools/spawn_agent.go:94](backend/internal/service/llm/tools/spawn_agent.go:94)).
- Converts domain spawn-limit/depth errors into tool-level recoverable results; infra errors bubble ([backend/internal/service/llm/tools/spawn_agent.go:111](backend/internal/service/llm/tools/spawn_agent.go:111), [backend/internal/service/llm/tools/spawn_agent.go:116](backend/internal/service/llm/tools/spawn_agent.go:116), [backend/internal/service/llm/tools/spawn_agent.go:125](backend/internal/service/llm/tools/spawn_agent.go:125)).

### Registration guards

- `WithSpawnTool` only registers if `spawnInvoker != nil` and work item context is present ([backend/internal/service/llm/tools/builder.go:97](backend/internal/service/llm/tools/builder.go:97), [backend/internal/service/llm/tools/builder.go:111](backend/internal/service/llm/tools/builder.go:111)).
- Production tool registry builder includes `WithSpawnTool(...)` in per-turn assembly ([backend/internal/service/llm/streaming/launch_stream.go:179](backend/internal/service/llm/streaming/launch_stream.go:179), [backend/internal/service/llm/streaming/launch_stream.go:185](backend/internal/service/llm/streaming/launch_stream.go:185)).

### Server tool policy mismatch (important)

- Server request-tool policy enumerates canonical default names in `serverDefaultToolOrder`; it currently excludes `spawn_agent` ([backend/internal/service/llm/streaming/tool_policy.go:16](backend/internal/service/llm/streaming/tool_policy.go:16)).
- `gather_context.resolveRequestParams` always rebuilds `request_params.tools` from this server policy ([backend/internal/service/llm/streaming/gather_context.go:304](backend/internal/service/llm/streaming/gather_context.go:304), [backend/internal/service/llm/streaming/gather_context.go:309](backend/internal/service/llm/streaming/gather_context.go:309), [backend/internal/service/llm/streaming/gather_context.go:314](backend/internal/service/llm/streaming/gather_context.go:314)).

Inference: `spawn_agent` appears wired in runtime registry but may be omitted from model-facing request tool schema/policy, which can make it unreachable in normal tool-calling behavior.

---

## 9) ContextResolver

- `ResolveWorkContext` is intentionally narrow: it maps `work_item_id` -> slug and emits:
  - `WorkDir=.meridian/work/<slug>/`
  - `FSDir=.meridian/fs`
  - `ThreadID`
  - `WorkItem` slug
  ([backend/internal/service/llm/streaming/context_resolver.go:33](backend/internal/service/llm/streaming/context_resolver.go:33), [backend/internal/service/llm/streaming/context_resolver.go:51](backend/internal/service/llm/streaming/context_resolver.go:51)).
- Caller contract is strict: must attach work item first or receive validation error ([backend/internal/service/llm/streaming/context_resolver.go:35](backend/internal/service/llm/streaming/context_resolver.go:35), [backend/internal/service/llm/streaming/context_resolver.go:41](backend/internal/service/llm/streaming/context_resolver.go:41)).

### Namespace isolation location

- The requested canonicalize -> detect -> check flow is implemented in text editor tool path guard, not in `ContextResolver` itself ([backend/internal/service/llm/tools/text_editor.go:504](backend/internal/service/llm/tools/text_editor.go:504), [backend/internal/service/llm/tools/text_editor.go:507](backend/internal/service/llm/tools/text_editor.go:507)).
- Enforcement includes:
  - Canonicalization with `filepath.Clean`
  - explicit raw `..` rejection
  - `.meridian/work/<slug>/` exact-slug write isolation
  - `.meridian/fs/` shared allowance
  - deny other `.meridian/*` and `.session/*`
  ([backend/internal/service/llm/tools/text_editor.go:519](backend/internal/service/llm/tools/text_editor.go:519), [backend/internal/service/llm/tools/text_editor.go:528](backend/internal/service/llm/tools/text_editor.go:528), [backend/internal/service/llm/tools/text_editor.go:539](backend/internal/service/llm/tools/text_editor.go:539), [backend/internal/service/llm/tools/text_editor.go:557](backend/internal/service/llm/tools/text_editor.go:557), [backend/internal/service/llm/tools/text_editor.go:568](backend/internal/service/llm/tools/text_editor.go:568), [backend/internal/service/llm/tools/text_editor.go:575](backend/internal/service/llm/tools/text_editor.go:575)).

---

## 10) TokenMonitor

### Threshold semantics (60/80/90)

- Canonical constants:
  - collapse `0.60`
  - compact `0.80`
  - warn `0.90`
  ([backend/internal/service/llm/streaming/token_monitor.go:31](backend/internal/service/llm/streaming/token_monitor.go:31), [backend/internal/service/llm/streaming/token_monitor.go:32](backend/internal/service/llm/streaming/token_monitor.go:32), [backend/internal/service/llm/streaming/token_monitor.go:33](backend/internal/service/llm/streaming/token_monitor.go:33)).
- Public API exposes additive flags `ShouldWarn -> ShouldCompact -> ShouldCollapse` ([backend/internal/service/llm/streaming/token_monitor.go:38](backend/internal/service/llm/streaming/token_monitor.go:38)).
- Handler mirrors same thresholds in API payload ([backend/internal/handler/context_budget.go:38](backend/internal/handler/context_budget.go:38)).

### Budget checking / side effects

- Check is synchronous token estimation; DB side effects are intentionally async ([backend/internal/service/llm/streaming/token_monitor.go:80](backend/internal/service/llm/streaming/token_monitor.go:80), [backend/internal/service/llm/streaming/token_monitor.go:225](backend/internal/service/llm/streaming/token_monitor.go:225)).
- Warn threshold emits `context_warning` SSE during stream ([backend/internal/service/llm/streaming/token_monitor.go:244](backend/internal/service/llm/streaming/token_monitor.go:244), [backend/internal/service/llm/streaming/token_monitor.go:251](backend/internal/service/llm/streaming/token_monitor.go:251)).
- Collapse marker persistence runs via goroutine/background context and does not block turn completion ([backend/internal/service/llm/streaming/token_monitor.go:267](backend/internal/service/llm/streaming/token_monitor.go:267), [backend/internal/service/llm/streaming/token_monitor.go:280](backend/internal/service/llm/streaming/token_monitor.go:280)).

---

## 11) CompactionService

### LLM-based summarization and bookmark persistence

- Compaction summarizes turns since most recent compaction bookmark (delta compaction) ([backend/internal/service/llm/streaming/compaction_service.go:99](backend/internal/service/llm/streaming/compaction_service.go:99), [backend/internal/service/llm/streaming/compaction_service.go:138](backend/internal/service/llm/streaming/compaction_service.go:138)).
- Uses dedicated fast model default (`claude-haiku-4-5-20251001`) and fixed summarizer system prompt ([backend/internal/service/llm/streaming/compaction_service.go:31](backend/internal/service/llm/streaming/compaction_service.go:31), [backend/internal/service/llm/streaming/compaction_service.go:34](backend/internal/service/llm/streaming/compaction_service.go:34)).
- Persists a `role=system` turn with `turn_type=compaction` and summary text block ([backend/internal/service/llm/streaming/compaction_service.go:103](backend/internal/service/llm/streaming/compaction_service.go:103), [backend/internal/service/llm/streaming/compaction_service.go:237](backend/internal/service/llm/streaming/compaction_service.go:237), [backend/internal/service/llm/streaming/compaction_service.go:240](backend/internal/service/llm/streaming/compaction_service.go:240)).
- Migration widened turn role constraint to include `system` for bookmark turns ([backend/migrations/00038_add_system_turn_role.sql:3](backend/migrations/00038_add_system_turn_role.sql:3), [backend/migrations/00038_add_system_turn_role.sql:9](backend/migrations/00038_add_system_turn_role.sql:9)).

### Bookmark-aware message building

- Compaction summary is injected as leading user context message; turns up to bookmark are skipped ([backend/internal/service/llm/thread_history/message_builder.go:64](backend/internal/service/llm/thread_history/message_builder.go:64), [backend/internal/service/llm/thread_history/message_builder.go:67](backend/internal/service/llm/thread_history/message_builder.go:67), [backend/internal/service/llm/thread_history/message_builder.go:88](backend/internal/service/llm/thread_history/message_builder.go:88)).

---

## 12) Collapsed content

### Pre-computed summary generation

- Tool executor computes `collapsed_content` at tool-result persistence time (currently for text editor and doc search) ([backend/internal/service/llm/streaming/tool_executor.go:153](backend/internal/service/llm/streaming/tool_executor.go:153), [backend/internal/service/llm/streaming/tool_executor.go:156](backend/internal/service/llm/streaming/tool_executor.go:156), [backend/internal/service/llm/streaming/tool_executor.go:547](backend/internal/service/llm/streaming/tool_executor.go:547)).
- Turn block model includes optional `CollapsedContent` for human-readable summaries ([backend/internal/domain/llm/turn_block.go:49](backend/internal/domain/llm/turn_block.go:49)).
- DB persistence/query paths include `collapsed_content` in insert/select APIs ([backend/internal/repository/postgres/llm/turn.go:591](backend/internal/repository/postgres/llm/turn.go:591), [backend/internal/repository/postgres/llm/turn.go:725](backend/internal/repository/postgres/llm/turn.go:725)).
- Migration added `collapsed_content TEXT` to `turn_blocks` ([backend/migrations/00036_add_collapsed_content.sql:3](backend/migrations/00036_add_collapsed_content.sql:3), [backend/migrations/00036_add_collapsed_content.sql:7](backend/migrations/00036_add_collapsed_content.sql:7)).

### Replacement behavior in message construction

- Before latest collapse marker, message builder replaces tool result payload with `collapsed_content` when present ([backend/internal/service/llm/thread_history/message_builder.go:125](backend/internal/service/llm/thread_history/message_builder.go:125), [backend/internal/service/llm/thread_history/message_builder.go:164](backend/internal/service/llm/thread_history/message_builder.go:164), [backend/internal/service/llm/thread_history/message_builder.go:180](backend/internal/service/llm/thread_history/message_builder.go:180)).

---

## Work-item + spawn persistence details (supporting)

- Thread table persistence includes spawn lineage fields and JSON spawn result ([backend/internal/repository/postgres/llm/thread.go:453](backend/internal/repository/postgres/llm/thread.go:453)).
- Running-spawn counting query is `COUNT(*) WHERE work_item_id=? AND spawn_status='running'` ([backend/internal/repository/postgres/llm/thread.go:479](backend/internal/repository/postgres/llm/thread.go:479), [backend/internal/repository/postgres/llm/thread.go:485](backend/internal/repository/postgres/llm/thread.go:485)).
- Child listing query keyed by `parent_thread_id` ([backend/internal/repository/postgres/llm/thread.go:499](backend/internal/repository/postgres/llm/thread.go:499), [backend/internal/repository/postgres/llm/thread.go:505](backend/internal/repository/postgres/llm/thread.go:505)).

---

## Decision rationale recovered from session history

From parent-session transcript searches:

- `spawn_depth` denormalization was an explicit design decision to avoid O(n) ancestor walks and make depth checks O(1).
- Ephemeral cap behavior intentionally includes reuse-at-cap and create-on-race fallback when the reuse target disappears.
- `collapsed_content` is intended as pre-computed compression substrate so later bookmark logic can substitute shorter text without expensive recomputation.

These rationales are consistent with current implementation in `spawn_service`, `workitem/service`, and `tool_executor + message_builder`.

---

## Drift/risk observations

1. **Potential spawn tool reachability gap**
- Runtime builder registers `spawn_agent`, but server default tool policy excludes it from request params tool list.
- If provider/tool exposure is governed only by request params tools, spawn may not be callable despite registry wiring.

2. **Shutdown coordinator integration gap**
- `ShutdownCoordinator` exists with full graceful-shutdown flow, but no obvious runtime registration in stream launch path.
- Current production path visibly uses `executorRegistry`; coordinator might be dead code or wired elsewhere outside explored slice.

3. **Concurrent-spawn race window**
- `validateSpawnLimits` count check and child thread creation are separate operations; without a locking/atomic guard this can overshoot under contention.
- Current implementation likely accepts occasional oversubscription as tradeoff.

4. **Ephemeral cap is advisory under races (by design)**
- At-cap fallback intentionally creates a new ephemeral when reuse target vanishes; this preserves forward progress over strict cap enforcement.

---

## Attempted delegated exploration

- I attempted to run explorer delegations via `meridian spawn` for parallel legwork.
- All spawned runs failed with `Failure: orphan_run` in this environment, so I completed exploration directly via local code inspection and session-context mining.

