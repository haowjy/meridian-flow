# v1 Launch Backlog

## Critical (fix before launch)

| Issue | Location | Fix | Status |
|-------|----------|-----|--------|
| Spawn `waitForCompletion` uses `AuthorizeTurnStream` with `userID=""` | `streaming/spawn_service.go:409-442` | Expose real executor completion signal or poll persisted turn state, not auth API | ✅ |
| Spawn limit race — count+insert not in same transaction | `streaming/spawn_service.go:66-118` | Move count+insert into one transaction with locking or DB-level cap enforcement | ✅ |
| `remaining_input` always 0 for kimi-k2.5 | `context_budget.go` + model capabilities | `max_output` set to full `context_window` (262144) — fix model capability data | ✅ |

## High Priority — Architecture

| Item | Design Doc | What to Build | Status |
|------|-----------|--------------|--------|
| Multiplex agent SSE streams | `_docs/future/refactoring-backlog.md` (SSE connection starvation) | Single project-level SSE/WS for all agent events. Per-turn SSE shares browser's HTTP/1.1 6-connection limit — 3 agent streams starve API calls. Multiplex with channel-based subscribe/unsubscribe. | ⬜ |

## Required Features

| Item | Design Doc | What to Build | Status |
|------|-----------|--------------|--------|
| Background execution | `features/agents/background-execution.md` | `background_tasks` table, detached goroutine manager, `check_background` tool, server restart recovery | ⬜ |
| Thread notifications | `features/agents/thread-notifications.md` | `internal` turn role, ThreadNotifier, WebSocket `thread_activity` events, auto-wake | ⬜ |
| Arbitrary tool registration | — | Open tool registry (MCP-style). Built-in and external tools register the same way. Persona allow/deny works uniformly. | ⬜ |
| Skill CRUD migration (Phase A) | `refactoring-design.md` (Skill Migration section) | File-backed ProjectSkillService, removed `enabled` from API. Phase B (remove DB tables) deferred to Phase 4. | ✅ |
