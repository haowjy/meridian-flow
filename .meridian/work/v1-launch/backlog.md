# v1 Launch Backlog

## Critical (fix before launch)

| Issue | Location | Fix | Status |
|-------|----------|-----|--------|
| Spawn `waitForCompletion` uses `AuthorizeTurnStream` with `userID=""` | `streaming/spawn_service.go:409-442` | Expose real executor completion signal or poll persisted turn state, not auth API | ✅ |
| Spawn limit race — count+insert not in same transaction | `streaming/spawn_service.go:66-118` | Move count+insert into one transaction with locking or DB-level cap enforcement | ✅ |
| `remaining_input` always 0 for kimi-k2.5 | `context_budget.go` + model capabilities | `max_output` set to full `context_window` (262144) — fix model capability data | ✅ |

## Required Features

| Item | Design Doc | What to Build | Status |
|------|-----------|--------------|--------|
| Background execution | `features/agents/background-execution.md` | `background_tasks` table, detached goroutine manager, `check_background` tool, server restart recovery | ⬜ |
| Thread notifications | `features/agents/thread-notifications.md` | `internal` turn role, ThreadNotifier, WebSocket `thread_activity` events, auto-wake | ⬜ |
| Arbitrary tool registration | — | Open tool registry (MCP-style). Built-in and external tools register the same way. Persona allow/deny works uniformly. | ⬜ |
| Skill CRUD migration | `refactoring-design.md` (Skill Migration section) | Replace DB-first skill CRUD with file-first writes to `.agents/skills/`. Remove split-brain. | ⬜ |
