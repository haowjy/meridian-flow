# Refactoring Backlog

Technical debt and refactoring opportunities discovered during development.

## How to Use
- Run `/backlog` to review and update this file
- Items are prioritized: High -> Medium -> Low
- Check off items when completed (⬜ -> ✅)

---

## Backend

### Critical (fix before launch)

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| Spawn `waitForCompletion` uses `AuthorizeTurnStream` with `userID=""` | `streaming/spawn_service.go:409-442` | Expose real executor completion signal or poll persisted turn state, not auth API | ⬜ |
| Spawn limit race — count+insert not in same transaction | `streaming/spawn_service.go:66-118` | Move count+insert into one transaction with locking or DB-level cap enforcement | ⬜ |
| `remaining_input` always 0 for kimi-k2.5 | `context_budget.go` + model capabilities | `max_output` set to full `context_window` (262144) — fix model capability data | ⬜ |

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
| Inline orchestration in service methods | Various `service/llm/` methods | Audit for shared logic that should be standalone functions (like `FormatToolResultContent` was extracted from `formatToolResultBlock`) | ⬜ |
| Path resolver naming inconsistency | `domain/docsystem/path_resolver.go`, `service/docsystem/path_resolver.go`, `tools/path_resolver.go` | Promote one read-only folder lookup interface in docsystem, reuse from tools | ⬜ |
| Work item slug→ID double lookup | `handler/work_item.go`, `service/workitem/service.go` | Expose slug-based mutation methods, or make (projectID, userID, slug) the service boundary | ⬜ |
| Agent catalog parallel bespoke loaders | `service/agents/skill_resolver.go`, `persona_catalog.go` | Extract shared markdown-catalog loader, align Resolve/List vocabulary | ⬜ |
| Tool path not truly Open/Closed | `tools/builder.go`, `launch_stream.go` | Factory registry keyed by tool/provider name | ⬜ |
| Dual error format (DomainError vs RFC 7807) | `handler/helpers.go`, various handlers | Migrate all to DomainError format, document transition | ⬜ |
| `?status=` filter silently ignored on list work items | `handler/work_item.go` | Read status query param, pass to store query | ⬜ |
| Non-UUID path params return 500 not 400 | Context budget, spawn, work item handlers | Add `parseUUID()` validation before DB calls (persona handler already does this) | ⬜ |

### Low Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| No portable log-query abstraction | `.agents/skills/orchestrate/scripts/` | Create `query-log.sh` that abstracts output format differences across Claude/Codex/OpenCode backends, enabling agents to search/slice agent run logs without knowing the format | ⬜ |

### v1 Deferred (post-v1, all additive)

| Item | Design Doc | What to Build | Pre-launch Gate? | Status |
|------|-----------|--------------|:----------------:|--------|
| Background execution | `.meridian/work/v1-launch/features/agents/background-execution.md` | `background_tasks` table, detached goroutine manager, `check_background` tool, server restart recovery | No | ⬜ |
| Thread notifications | `.meridian/work/v1-launch/features/agents/thread-notifications.md` | `internal` turn role, ThreadNotifier, WebSocket `thread_activity` events, auto-wake | No | ⬜ |
| Provider middleware | `.meridian/work/v1-launch/features/middleware/provider-middleware.md` | Generic `ProviderMiddleware` interface + `WrapProvider` in meridian-llm-go, usage metering middleware | No | ⬜ |
| Full SSRF DNS-pinning | `.meridian/work/v1-launch/features/agents/agent-import.md` | Custom `net.Dialer` with DNS resolution, IP range validation (incl IPv4-mapped IPv6), TLS hostname pinning. Replace allowlist-only. | **Yes** | ⬜ |
| Anthropic token estimator | `.meridian/work/v1-backend-implementation/design/token-budget.md` | `POST /v1/messages/count_tokens` integration, cache layer, estimator registry with fallback | No | ⬜ |
| Cursor-based pagination | `.meridian/work/v1-backend-implementation/design/work-items.md` | Replace offset/limit with opaque cursor on work item + thread list endpoints | No | ⬜ |
| `query_history` tool | `.meridian/work/v1-launch/features/agents/context-management.md` | FTS over pre-bookmark turns, compaction segment search | No | ⬜ |
| Concurrent spawn artifact locking | Review finding C8 | Advisory file-level locking or per-spawn subdirectories in `.meridian/work/<slug>/` | No | ⬜ |
| WebSocket thread event channel | Review finding C7 | Separate from collab WS. Subscription lifecycle, event type catalog, coexistence | No | ⬜ |
| Graceful shutdown v2 | Review finding C2 | Full drain of background tasks + spawn goroutines (v1 covers foreground streaming only) | No | ⬜ |

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

### Low Priority

(empty)
