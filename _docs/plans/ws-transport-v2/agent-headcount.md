---
detail: standard
audience: developer, architect
---
# ws-transport-v2 Stage 1: Agent Headcount and Orchestration

## Orchestration Model

**Primary orchestrator**: Claude Opus (this conversation) -- exercises ultimate judgment on all decisions, resolves conflicts between reviewers, approves merges between phases. NEVER writes implementation code directly.

**Implementation**: via `meridian spawn -a coder -m codex` -- one implementer at a time per worktree to avoid merge conflicts.

**Code review**: via `meridian spawn -a reviewer -m gpt` -- 2-3 reviewers per phase, fanned out in parallel with different review angles.

**Unit testing**: via `meridian spawn -a unit-tester -m gpt` -- writes focused unit tests to verify correctness, runs them, reports results. Tests are marked with `[unit-tester]` comments so orchestrator can decide keep vs discard.

**Smoke testing**: via `meridian spawn -a smoke-tester -m sonnet` -- QA agent that writes disposable curl/WS scripts to test from the outside like a real user. Scripts go in `scratch/smoke/` (gitignored).

**Tracking**: orchestrator appends to `implementation-log.md` after each spawn report -- decisions, weird findings, backlog items, bugs.

## Execution Workflow (per phase)

```
1. Orchestrator composes implementation prompt
   - References: design docs (-f), existing code (-f), previous findings
   - Clear scope boundaries: one phase, specific files
   |
   v
2. meridian spawn -m codex -a coder -p "Phase N: ..." -f [context files]
   - Wait for completion: meridian spawn wait <id>
   - Read report: meridian spawn show <id>
   |
   v
3. Orchestrator evaluates implementation report
   - Check: did it follow the design? any deviations?
   - Log weird findings to implementation-log.md
   |
   v
4. Fan out 2-3 reviewers (parallel)
   meridian spawn -m gpt -a reviewer -p "Review Phase N: correctness" -f [files]
   meridian spawn -m gpt -a reviewer -p "Review Phase N: Go idioms" -f [files]
   meridian spawn wait <id1> <id2>
   |
   v
5. Orchestrator synthesizes review findings
   - CRITICAL -> must fix before approve
   - MEDIUM -> orchestrator decides (fix or defer)
   - LOW -> log to implementation-log.md, move on
   |
   v
6. If issues: spawn targeted fix + re-review (max 3 cycles)
   If clean: commit, update plan status, move to next phase
```

## Per-Phase Staffing

### Phase 0: Foundation (~400 lines)
- 1x `meridian spawn -a coder -m codex` -- session manager fixes + authenticator refactor + error sentinels
- 2x `meridian spawn -a reviewer -m gpt` -- (1) correctness/concurrency, (2) Go idioms
- 1x `meridian spawn -a unit-tester -m gpt` -- verify singleflight + refcount guards with race tests
- Gate: orchestrator approves, all existing + new tests pass

### Phase 1A: Document WS Handler (~700 lines)
- 1x `meridian spawn -a coder -m codex` -- new document handler + registry
- 2x `meridian spawn -a reviewer -m gpt` -- (1) correctness, (2) security (auth, origin, limits)
- 1x `meridian spawn -a unit-tester -m gpt` -- handler tests: handshake, heartbeat, limits
- 1x `meridian spawn -a smoke-tester -m sonnet` -- connect to /ws/documents/{id}, send bad auth, oversized frames
- Gate: orchestrator approves, Yjs handshake works

### Phase 1B: Project WS Simplification (~800 lines)
- 1x `meridian spawn -a coder -m codex` -- strip binary/subscription, split broadcast
- 2x `meridian spawn -a reviewer -m gpt` -- (1) correctness, (2) backwards compat (proposal flow intact)
- 1x `meridian spawn -a unit-tester -m gpt` -- proposal routing tests, verify binary rejection
- Gate: orchestrator approves, proposals work correctly
- NOTE: runs in parallel with 1A via git worktree

### Phase 2: Cleanup (~300 net lines)
- 1x `meridian spawn -a coder -m codex` -- delete dead code, update interfaces
- 1x `meridian spawn -a reviewer -m gpt` -- dead code / unused imports / build check
- Gate: build passes, all tests pass

### Phase 3: Frontend (~1000 lines)
- 1x `meridian spawn -a coder -m codex` -- DocumentSessionManager + hook rewrites
- 2x `meridian spawn -a reviewer -m gpt` -- (1) React patterns/lifecycle, (2) TypeScript + warm pool logic
- 1x `meridian spawn -a smoke-tester -m sonnet` -- open document in browser, test warm pool transitions
- Gate: pnpm build + lint pass

## Agent Profiles

All agents defined in `.claude/agents/`. Use with `meridian spawn -a <name>`.

| Agent | Profile | Default Model | Purpose |
|-------|---------|---------------|---------|
| `coder` | Implementation | gpt-5.3-codex | Write production code, follow SOLID |
| `reviewer` | Code review | gpt-5.4 | Read-only review against project rules |
| `unit-tester` | Test engineer | gpt-5.4 | Write focused unit tests, run them, report results |
| `smoke-tester` | QA tester | claude-sonnet-4-6 | Write disposable scripts to test from outside |
| `researcher` | Investigation | gpt-5.3-codex | Read-only codebase exploration + web search |

## Review Angles (passed via prompt, not separate agents)

| Angle | Focus | Phases |
|-------|-------|--------|
| Correctness | Logic errors, edge cases, nil checks | All |
| Concurrency | Races, deadlocks, lock ordering, goroutine leaks | 0, 1A |
| Security | Auth bypass, origin validation, rate limiting | 1A |
| Go idioms | Context threading, error wrapping, interface design | 0, 1A, 1B |
| React/TS | Hook lifecycle, cleanup, TypeScript strictness | 3 |
| Backwards compat | Proposal flow intact, no regressions | 1B |
| Tiebreaker | Conflict resolution, final judgment (orchestrator) | As needed |

## Parallel Work Strategy

Phases 1A and 1B can run in parallel using **git worktrees**:
- Main worktree: Phase 1A (document WS handler)
- Worktree branch: Phase 1B (project WS simplification)
- Both branch from the Phase 0 commit
- Merge both into the feature branch before Phase 2

Within a single worktree, work is SEQUENTIAL (one implementer at a time). Parallel reviewers are read-only.

## Orchestrator Responsibilities

1. **Compose prompts** -- detailed, scoped, with correct -f context files
2. **Evaluate reports** -- never blindly accept; check against design docs
3. **Synthesize reviews** -- resolve reviewer conflicts, make final calls
4. **Track everything** -- append to `implementation-log.md` after each spawn:
   - Decisions made (even small ones)
   - Weird things the implementer found
   - Backlog items for later
   - Bugs discovered but not fixing now
5. **Manage phase gates** -- approve completion, trigger next phase
6. **Exercise ultimate judgment** -- reviewers advise, orchestrator decides
7. **Commit after each phase** -- testable state, clear commit message
