# Refactoring Backlog

General technical debt not tied to a specific work item. Work-item-scoped backlogs live in `.meridian/work/<slug>/backlog.md`.

---

## Backend

### High Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| **SSE connection starvation** — each agent turn opens a separate SSE stream. SSE shares the browser's HTTP/1.1 per-origin limit (~6). With 3+ agent streams, regular API calls queue behind them. | `handler/sse_handler.go`, `handler/llm/thread_handler.go` | Multiplex all agent streams onto a single SSE (or WS) connection per project. Client subscribes to turn IDs on the shared connection; server fans out events by channel. Same pattern applies to spawn sub-agent streams. | ⬜ |
| `SetSpawnInvoker` runtime type assertion | `llm/setup.go:211` | Make spawn wiring an explicit constructor dependency instead of runtime mutation | ✅ |
| Streaming `Service` god object | `streaming/service.go`, `deps.go`, `setup.go` | Decomposed into 4 collaborators (TurnContextResolver, ToolRegistryFactory, StreamRequestBuilder, StreamRuntime). Service down to ~17 fields. | ✅ |
| Debug vs production prompt construction diverge | `assemble_prompt.go` vs `debug.go:124` | Extract shared helper for skills/tools/persona/work-item filtering, reuse in both paths | ✅ |
| **Hard-cancel during pre-start window** — InterruptTurn during BuildConversationMessages bypasses all executor cleanup (tokens, billing, slot, status) because workFunc early-returns on cancelled context | `stream_runtime.go`, `stream_executor.go` | Goroutine must check executor cancellation state, not HTTP context. Either defer cleanup in workFunc or make startStreamingExecution cancellation-aware. | ⬜ |
| **Stream-switch interjection race** — UpsertInterjection between drain and follow-up turn creation writes to old buffer, which gets deleted. User input silently lost. | `stream_runtime.go`, `completion_handler.go`, `interjection.go` | Rethink drain-and-switch protocol. Either lock the buffer during switch or queue interjections for the replacement turn. | ⬜ |
| **Stream-switch N+1 slot requirement** — replacement turn acquires slot before old releases. Users at concurrent limit get transient failure on 1-for-1 swap. | `turn_context_resolver.go`, `stream_runtime.go` | Release old slot before acquiring new, or exempt stream-switch from slot acquisition. | ⬜ |
| **SpawnInvokerRef temporal coupling** — closure captures nil, assigned after construction. Localized to ToolRegistryFactory but still post-construction mutation. | `tool_registry_factory.go`, `setup.go` | Eliminate circular dep between SpawnService and StreamingService, or make ToolRegistryFactory accept SpawnInvoker at request time. | ⬜ |
| **Debug path param ordering** — debug endpoint parses params before server tool policy, extracts enabledTools before overwriting requestParams["tools"]. Production does it in opposite order with capability filtering. | `debug.go` | Make debug use TurnContextResolver for faithful production mirroring, or align param ordering manually. | ⬜ |
| **No focused collaborator tests** — ToolRegistryFactory, StreamRequestBuilder, StreamRuntime have zero dedicated tests. Old pipeline tests pass but don't exercise new boundaries. | `streaming/` | Add focused unit tests for each collaborator with narrow mocks. | ⬜ |
| Duplicate error handling | `document.go:54-98`, `folder.go:64-103` | Extract `handleCreateError()` | ⬜ |
| Repeated identifier resolution | `document.go:77-87, 119-135, 209-220, 297-308` | Extract `resolveDocumentID()` | ✅ |
| Large interfaces (ISP) | `domain/repositories/docsystem/document.go` | Split into Reader/Writer/Metadata | ✅ |
| `TurnReader` interface too fat | `domain/llm/turn_reader.go` | Split — `OwnerBasedAuthorizer` only needs `GetTurn`, `CompactionService` stubs unused methods | ⬜ |

### Medium Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| `launch_stream.go` wrapper not absorbed by StreamRuntime | `streaming/launch_stream.go` | Move thread hydration, work-item derivation, registry construction into StreamRuntime.Launch so non-CreateTurn launch paths don't duplicate | ⬜ |
| Inline orchestration in service methods | Various `service/llm/` methods | Audit for shared logic that should be standalone functions | ⬜ |
| Path resolver naming inconsistency | `domain/docsystem/path_resolver.go`, `service/docsystem/path_resolver.go`, `tools/path_resolver.go` | Promote one read-only folder lookup interface in docsystem, reuse from tools | ✅ |
| Work item slug→ID double lookup | `handler/work_item.go`, `service/workitem/service.go` | Expose slug-based mutation methods | ✅ |
| Agent catalog parallel bespoke loaders | `service/agents/skill_resolver.go`, `persona_catalog.go` | Extract shared markdown-catalog loader | ⬜ |
| Tool path not truly Open/Closed | `tools/builder.go`, `launch_stream.go` | Factory registry keyed by tool/provider name | ⬜ |
| Dual error format (DomainError vs RFC 7807) | `handler/helpers.go`, various handlers | Migrate all to DomainError format | ⬜ |
| `?status=` filter silently ignored on list work items | `handler/work_item.go` | Read status query param, pass to store query | ✅ |
| Non-UUID path params return 500 not 400 | Context budget, spawn, work item handlers | Add `parseUUID()` validation before DB calls | ✅ |

### Post-v1 (additive)

| Item | Design Doc | What to Build | Status |
|------|-----------|--------------|--------|
| Provider middleware | `.meridian/work/v1-launch/features/middleware/provider-middleware.md` | Generic `ProviderMiddleware` interface + `WrapProvider` in meridian-llm-go | ⬜ |
| Full SSRF DNS-pinning | `.meridian/work/v1-launch/features/agents/agent-import.md` | Custom `net.Dialer` with DNS resolution, IP range validation | ⬜ |
| Anthropic token estimator | `.meridian/work/v1-backend-implementation/design/token-budget.md` | `POST /v1/messages/count_tokens` integration | ⬜ |
| Cursor-based pagination | `.meridian/work/v1-backend-implementation/design/work-items.md` | Replace offset/limit with opaque cursor | ⬜ |
| `query_history` tool | `.meridian/work/v1-launch/features/agents/context-management.md` | FTS over pre-bookmark turns, compaction segment search | ⬜ |
| Concurrent spawn artifact locking | Review finding C8 | Advisory file-level locking or per-spawn subdirectories | ⬜ |
| WebSocket thread event channel | Review finding C7 | Separate from collab WS | ⬜ |
| Graceful shutdown v2 | Review finding C2 | Full drain of background tasks + spawn goroutines | ⬜ |

---

## Frontend

### High Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| SRP violation | `useThreadStore.ts` (1,021 lines) | Split into separate stores | ⬜ |
| SRP violation | `DocumentTreeContainer.tsx` (746 lines) | Extract operation modules | ⬜ |
| Inconsistent dialogs | `DeleteFolderDialog.tsx` | Use `DeleteConfirmationDialog` | ⬜ |
| Duplicate keyboard handling | `TurnInput.tsx`, `EditTurnInput.tsx` | Extract shared hook | ⬜ |

### Medium Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| SheetContent defaults `gap-4 p-4` but both consumers override to `gap-0 p-0` | `shared/components/ui/sheet.tsx` | Change defaults to `gap-0 p-0`, let consumers opt in to spacing | ⬜ |
