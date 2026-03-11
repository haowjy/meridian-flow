---
detail: standard
audience: developer, architect
---
# ws-transport-v2 Stage 1: Agent Staffing

Per-phase agent assignments. All agents defined in `.claude/agents/`, used via `meridian spawn -a <name>`.

Tracking: orchestrator appends to `../tracking/log.md` after each phase.

## Review Loop

Every phase follows: implement -> fan out reviewers -> synthesize -> fix -> re-review (max 3 cycles). Phase gate = reviewer consensus + tests pass. Orchestrator resolves disagreements.

```
coder implements
  |
  v
fan out reviewers (parallel)
  |
  v
orchestrator synthesizes findings
  |-- all clear -> gate check -> next phase
  |-- issues -> coder fixes -> re-review (loop, max 3)
  |-- disagreement -> tiebreak with different model
```

## Per-Phase Staffing

### Phase 0: Foundation (~400 lines)
- `coder -m codex` -- session manager fixes + authenticator refactor + error sentinels
- `reviewer-solid` -- SOLID, code consistency
- `reviewer-concurrency` -- singleflight + refcount race analysis
- `unit-tester` -- verify singleflight + refcount guards with race tests
- `reviewer-planning` -- does Phase 0 set up Phase 1A/1B correctly?
- `documenter -m haiku` then `-m opus` -- update design docs if implementation deviated

### Phase 1A: Document WS Handler (~700 lines)
- `coder -m codex` -- new document handler + registry
- `reviewer-solid` -- consistency with existing handlers
- `reviewer-concurrency` -- connection lifecycle, goroutine leaks
- `reviewer-security` -- auth, origin, rate limits, frame size
- `unit-tester` -- handler tests: handshake, heartbeat, limits
- `smoke-tester` -- connect to /ws/documents/{id}, bad auth, oversized frames
- `reviewer-planning` -- API shape right for Phase 3 frontend?
- `documenter -m opus` -- update feature docs, API contract

### Phase 1B: Project WS Simplification (~800 lines)
- `coder -m codex` -- strip binary/subscription, split broadcast
- `reviewer-solid` -- clean separation of JSON vs binary paths
- `reviewer-concurrency` -- broadcast fanout, connection registry
- `unit-tester` -- proposal routing tests, verify binary rejection
- `reviewer-planning` -- proposal flow intact for existing frontend?
- `documenter -m opus` -- update proposal event docs
- Runs in parallel with 1A via git worktree

### Phase 2: Cleanup (~300 net lines)
- `coder -m codex` -- delete dead code, update interfaces
- `reviewer-solid` -- dead code, unused imports, interface hygiene

### Phase 3: Frontend (~1000 lines)
- `coder -m codex` -- DocumentSessionManager + hook rewrites
- `reviewer-solid` -- React/TS patterns, store consistency
- `reviewer-concurrency` -- async interleaving, warm pool lifecycle
- `smoke-tester` -- open document in browser, test warm pool transitions
- `reviewer-planning` -- does the frontend match the backend API?
- `documenter -m opus` -- final doc sweep

## Parallel Strategy

Phases 1A and 1B run in parallel using git worktrees. Both branch from the Phase 0 commit, merge before Phase 2.

Within a single worktree, work is sequential (one implementer at a time). Reviewers are read-only and can fan out in parallel.
