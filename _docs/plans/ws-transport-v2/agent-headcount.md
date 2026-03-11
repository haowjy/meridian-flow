---
detail: standard
audience: developer, architect
---
# ws-transport-v2 Stage 1: Agent Headcount and Orchestration

## Orchestration Model

**Primary orchestrator**: Claude Opus (this conversation) -- exercises ultimate judgment on all decisions, resolves conflicts between reviewers, approves merges between phases. NEVER writes implementation code directly.

**Implementation**: via `meridian spawn -m gpt-5.3-codex` (alias: `codex`) -- one implementer at a time per worktree to avoid merge conflicts.

**Review**: via `meridian spawn -m gpt-5.4` (alias: `gpt`) -- 2-3 reviewers per phase, fanned out in parallel with different review angles.

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
- 1x `codex` implementer: session manager fixes + authenticator refactor + error sentinels
- 2x `gpt` reviewers: (1) correctness/concurrency, (2) Go idioms
- Gate: orchestrator approves, all existing tests pass

### Phase 1A: Document WS Handler (~700 lines)
- 1x `codex` implementer: new document handler + tests + registry
- 3x `gpt` reviewers: (1) correctness, (2) security (auth, origin, limits), (3) test coverage
- Gate: orchestrator approves, Yjs handshake works

### Phase 1B: Project WS Simplification (~800 lines)
- 1x `codex` implementer: strip binary/subscription, split broadcast
- 2x `gpt` reviewers: (1) correctness, (2) backwards compat (proposal flow intact)
- Gate: orchestrator approves, proposals work correctly
- NOTE: runs in parallel with 1A via git worktree

### Phase 2: Cleanup (~300 net lines)
- 1x `codex` implementer: delete dead code, update interfaces
- 1x `gpt` reviewer: dead code / unused imports / build check
- Gate: build passes, all tests pass

### Phase 3: Frontend (~1000 lines)
- 1x `codex` implementer: DocumentSessionManager + hook rewrites
- 2x `gpt` reviewers: (1) React patterns/lifecycle, (2) TypeScript + warm pool logic
- Gate: pnpm build + lint pass

## Reviewer Profiles

| Role | Model | Focus | Phases |
|------|-------|-------|--------|
| Correctness | gpt-5.4 | Logic errors, edge cases, nil checks | All |
| Concurrency | gpt-5.4 | Races, deadlocks, lock ordering, goroutine leaks | 0, 1A |
| Security | gpt-5.4 | Auth bypass, origin validation, rate limiting | 1A |
| Go idioms | gpt-5.4 | Context threading, error wrapping, interface design | 0, 1A, 1B |
| Test coverage | gpt-5.4 | Missing test cases, edge cases, goleak usage | 1A, 1B |
| React/TS | gpt-5.4 | Hook lifecycle, cleanup, TypeScript strictness | 3 |
| Backwards compat | gpt-5.4 | Proposal flow intact, no regressions | 1B |
| Tiebreaker | claude-opus | Conflict resolution, final judgment | As needed |

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
