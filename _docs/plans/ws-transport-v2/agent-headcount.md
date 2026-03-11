---
detail: standard
audience: developer, architect
---
# ws-transport-v2 Stage 1: Agent Headcount

## Orchestration Model

**Primary orchestrator**: Claude Opus (this conversation) -- exercises ultimate judgment on all decisions, resolves conflicts between reviewers, approves merges between phases.

**Implementation model**: GPT-5.4 (preferred) -- handles all code writing via run-agent. One implementer at a time per phase to avoid merge conflicts.

**Review model**: GPT-5.4 (primary), Claude Opus (tiebreaker/escalation) -- 2-3 reviewers per phase, different review angles.

## Per-Phase Staffing

### Phase 0: Foundation
- 1x GPT-5.4 implementer (session manager fixes + authenticator refactor)
- 2x GPT-5.4 reviewers: (1) correctness/concurrency, (2) Go idioms
- Gate review: orchestrator approves

### Phase 1A: Document WS Handler
- 1x GPT-5.4 implementer
- 3x GPT-5.4 reviewers: (1) correctness, (2) security (auth, origin, limits), (3) test coverage
- Gate review: orchestrator approves

### Phase 1B: Project WS Simplification
- 1x GPT-5.4 implementer
- 2x GPT-5.4 reviewers: (1) correctness, (2) backwards compatibility (proposal flow intact)
- Gate review: orchestrator approves

### Phase 2: Cleanup
- 1x GPT-5.4 implementer
- 1x GPT-5.4 reviewer: dead code / unused imports / build check
- Gate review: orchestrator approves

### Phase 3: Frontend
- 1x GPT-5.4 implementer
- 2x GPT-5.4 reviewers: (1) React patterns/lifecycle, (2) TypeScript strictness + warm pool logic
- Gate review: orchestrator approves

## Review Loop Process

```
Implementer writes code
    |
    v
Fan out to 2-3 reviewers (parallel, GPT-5.4)
    |
    v
Orchestrator synthesizes findings
    |
    +-- No issues --> Approve, move to next phase
    |
    +-- Issues found --> Implementer fixes
                             |
                             v
                        Re-review (targeted, 1 reviewer on changed sections)
                             |
                             v
                        Orchestrator approves or escalates
```

Each review round should produce:
- Numbered findings with severity (CRITICAL/MEDIUM/LOW)
- CRITICAL = must fix before approve
- MEDIUM = should fix, orchestrator decides
- LOW = optional, track for later

## Reviewer Profiles

| Role | Model | Focus | When |
|------|-------|-------|------|
| Correctness reviewer | GPT-5.4 | Logic errors, edge cases, off-by-one, nil checks | Every phase |
| Concurrency reviewer | GPT-5.4 | Races, deadlocks, lock ordering, goroutine leaks | Phase 0, 1A |
| Security reviewer | GPT-5.4 | Auth bypass, origin validation, rate limiting, input validation | Phase 1A |
| Go idioms reviewer | GPT-5.4 | Context threading, error wrapping, interface design | Phase 0, 1A, 1B |
| Test coverage reviewer | GPT-5.4 | Missing test cases, edge case coverage, goleak usage | Phase 1A, 1B |
| React/TS reviewer | GPT-5.4 | Hook lifecycle, cleanup, TypeScript strictness, store patterns | Phase 3 |
| Backwards compat reviewer | GPT-5.4 | Proposal flow still works, no regressions in project WS | Phase 1B |
| Tiebreaker | Claude Opus | Conflict resolution, final judgment | As needed |

## Parallel Work Strategy

Phases 1A and 1B can run in parallel using **git worktrees**:
- Main worktree: Phase 1A (document WS handler)
- Second worktree: Phase 1B (project WS simplification)
- Both branch from the Phase 0 commit
- Merge both into the feature branch before Phase 2

Within a single worktree, work is SEQUENTIAL (one implementer at a time). Parallel reviewers read the same code but do not write.

## Orchestrator's Role

The orchestrator (Claude Opus in the primary conversation):
1. **Composes prompts** for each implementer/reviewer run -- never writes implementation code directly
2. **Provides context files** -- knows which design docs, existing code, and previous review findings are relevant
3. **Synthesizes review findings** -- resolves conflicts between reviewers, makes final call on MEDIUM findings
4. **Manages phase gates** -- approves phase completion, triggers next phase
5. **Tracks decisions** -- logs implementation decisions in decision-log.md
6. **Exercises ultimate judgment** -- reviewers advise, orchestrator decides
