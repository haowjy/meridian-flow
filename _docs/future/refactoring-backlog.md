# Refactoring Backlog

General technical debt not tied to a specific work item. Work-item-scoped backlogs live in `.meridian/work/<slug>/backlog.md`.

---

## Backend

### High Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| `SetSpawnInvoker` runtime type assertion | `llm/setup.go:211` | Make spawn wiring an explicit constructor dependency instead of runtime mutation | ⬜ |
| Streaming `Service` god object | `streaming/service.go`, `deps.go`, `setup.go` | Collapse into smaller streaming runtime bundle or inject feature collaborators | ⬜ |
| Debug vs production prompt construction diverge | `assemble_prompt.go` vs `debug.go:124` | Extract shared helper for skills/tools/persona/work-item filtering, reuse in both paths | ⬜ |
| Duplicate error handling | `document.go:54-98`, `folder.go:64-103` | Extract `handleCreateError()` | ⬜ |
| Repeated identifier resolution | `document.go:77-87, 119-135, 209-220, 297-308` | Extract `resolveDocumentID()` | ⬜ |
| Large interfaces (ISP) | `domain/repositories/docsystem/document.go` | Split into Reader/Writer/Metadata | ⬜ |
| `TurnReader` interface too fat | `domain/llm/turn_reader.go` | Split — `OwnerBasedAuthorizer` only needs `GetTurn`, `CompactionService` stubs unused methods | ⬜ |

### Medium Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| Inline orchestration in service methods | Various `service/llm/` methods | Audit for shared logic that should be standalone functions | ⬜ |
| Path resolver naming inconsistency | `domain/docsystem/path_resolver.go`, `service/docsystem/path_resolver.go`, `tools/path_resolver.go` | Promote one read-only folder lookup interface in docsystem, reuse from tools | ⬜ |
| Work item slug→ID double lookup | `handler/work_item.go`, `service/workitem/service.go` | Expose slug-based mutation methods | ⬜ |
| Agent catalog parallel bespoke loaders | `service/agents/skill_resolver.go`, `persona_catalog.go` | Extract shared markdown-catalog loader | ⬜ |
| Tool path not truly Open/Closed | `tools/builder.go`, `launch_stream.go` | Factory registry keyed by tool/provider name | ⬜ |
| Dual error format (DomainError vs RFC 7807) | `handler/helpers.go`, various handlers | Migrate all to DomainError format | ⬜ |
| `?status=` filter silently ignored on list work items | `handler/work_item.go` | Read status query param, pass to store query | ⬜ |
| Non-UUID path params return 500 not 400 | Context budget, spawn, work item handlers | Add `parseUUID()` validation before DB calls | ⬜ |

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
