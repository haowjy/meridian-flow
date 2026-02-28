# Meridian Channel — Orchestration Prompt

> **Purpose**: Structured prompt for `/orchestrate` to implement all 9 slices of `meridian-channel`.
>
> **Invoke**: `/orchestrate _docs/plans/meridian-channel/ORCHESTRATE.md`

---

## What We're Building

**Meridian Channel** (`pip install meridian-channel`) is a Python 3.14 CLI + MCP server + API tool provider that orchestrates multi-model agent runs. It replaces ~1,400 lines of bash scripts with a proper application: space persistence, context pinning, cost tracking, permission tiers, MCP-native tool exposure, and programmatic tool calling support (Anthropic API `code_execution` + `allowed_callers`).

- **CLI binary**: `meridian`
- **Python package**: `meridian-channel`
- **Imports**: `from meridian.lib import ...`
- **Runtime data**: `.meridian/`

## Plan Files (load with `-f` as needed)

| File | When to load |
|------|-------------|
| `_docs/plans/meridian-channel/README.md` | Always — overview, slice summary, dependency graph |
| `_docs/plans/meridian-channel/design-philosophy.md` | Always — P1-P12, `meridian` vs `meridian.lib` boundary |
| `_docs/plans/meridian-channel/architecture.md` | Slices 0-2, 5b — project layout, operation registry, storage protocols |
| `_docs/plans/meridian-channel/mcp-tools.md` | Slices 5b, 6 — tool definitions, parity contract, response types |
| `_docs/plans/meridian-channel/cli-contract.md` | Slice 5b — output modes, error schema, command grammar |
| `_docs/plans/meridian-channel/correctness-specs.md` | All slices — 10 invariants to preserve |
| `_docs/plans/meridian-channel/risk-and-gaps.md` | Slices 4, 6, 7 — gap resolution tracking |
| `_docs/plans/meridian-channel/migration-from-rust.md` | Slice 7 — what changed from Rust plan |

## Dependency Graph

```
Slice 0 (scaffold)
├── Slice 1 (state layer)      ← can run in parallel with Slice 2
│   ├── Slice 3 (prompt composition)
│   │   └── Slice 4 (execution engine)
│   │       ├── Slice 5a (extraction)
│   │       │   └── Slice 5b (MCP + CLI wiring)
│   │       │       ├── Slice 6 (space + context)
│   │       │       │   └── Slice 7 (safety + migration)
│   │       │       └── Slice 7
│   │       └── Slice 7
│   └── Slice 6
└── Slice 2 (harness + skills + models) ← parallel with Slice 1
    ├── Slice 3
    └── Slice 5b
```

## Execution Plan

### Phase 1: Foundation (Slice 0)

```bash
RUNNER=".claude/skills/run-agent/scripts/run-agent.sh"
SESSION="meridian-$(date -u +%Y%m%dT%H%M%SZ)"

# Slice 0 — Scaffold
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=0 \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/README.md \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -f _docs/plans/meridian-channel/architecture.md \
    -f _docs/plans/meridian-channel/slices/0-scaffold.md \
    -p "Implement Slice 0 of meridian-channel. Create the Python package scaffold, pyproject.toml, CLI skeleton (cyclopts), FastMCP server skeleton, domain types, operation registry with duplicate-name guard, mock harness, CI workflow, and smoke tests. All 20 acceptance criteria in the slice file must pass. Project root for the package is src/meridian/."
```

**Review** (low risk — scaffold only):
```bash
$RUNNER --agent reviewer --model claude-opus-4-6 \
    --session "$SESSION" --label slice=0,phase=review \
    -f _docs/plans/meridian-channel/slices/0-scaffold.md \
    -f _docs/plans/meridian-channel/architecture.md \
    -p "Review Slice 0 implementation against acceptance criteria. Check: pyproject.toml correctness, operation registry duplicate-name guard, domain types are frozen dataclasses with NewType IDs, CLI help works, tests pass."
```

### Phase 2: State + Adapters (Slices 1 & 2 — parallel)

```bash
# Slice 1 — State Layer (run in parallel with Slice 2)
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=1 \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/README.md \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -f _docs/plans/meridian-channel/architecture.md \
    -f _docs/plans/meridian-channel/slices/1-state-layer.md \
    -p "Implement Slice 1 of meridian-channel. Create SQLite state layer with WAL mode, 8 tables (runs, spaces, pinned_files, workflow_events, spans, run_edges, artifacts, schema_info), embedded migrations, JSONL dual-write for backwards compat, ArtifactStore Protocol with LocalStore and InMemoryStore, file locking via fcntl.flock, and ID generation. All acceptance criteria must pass."

# Slice 2 — Harness Adapters + Skills + Models (parallel with Slice 1)
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=2 \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/README.md \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -f _docs/plans/meridian-channel/architecture.md \
    -f _docs/plans/meridian-channel/slices/2-harness-skills-models.md \
    -p "Implement Slice 2 of meridian-channel. Create HarnessAdapter Protocol with Claude/Codex/OpenCode/Direct adapters, model-to-harness routing, skill registry scanning .agents/skills/ with YAML frontmatter parsing and SQLite indexing, model guidance loading with override precedence, agent profile parsing, and skill/model operations (list, search, show, reindex). DirectAdapter calls the Anthropic Messages API with code_execution and generates tool definitions from the Operation Registry with allowed_callers: [code_execution_20260120] for programmatic tool calling. All acceptance criteria must pass."
```

**Review** (medium risk — state layer + adapters):
```bash
$RUNNER --agent reviewer --model gpt-5.3-codex \
    --session "$SESSION" --label slice=1-2,phase=review,reviewer=codex \
    -f _docs/plans/meridian-channel/slices/1-state-layer.md \
    -f _docs/plans/meridian-channel/slices/2-harness-skills-models.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Review Slices 1-2 implementation. Check: SQLite WAL mode + busy timeout, JSONL dual-write locking, migration versioning, HarnessAdapter Protocol compliance, skill index correctness, correctness specs 1 (finalization) and 5 (ID uniqueness) and 7 (lock correctness)." &

$RUNNER --agent reviewer --model claude-opus-4-6 \
    --session "$SESSION" --label slice=1-2,phase=review,reviewer=opus \
    -f _docs/plans/meridian-channel/slices/1-state-layer.md \
    -f _docs/plans/meridian-channel/slices/2-harness-skills-models.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Review Slices 1-2 implementation. Focus on: storage Protocol compliance (both sync and async variants), concurrency safety of JSONL dual-write, nullable-first migration policy, skill discovery correctness (spec 9: .agents/skills/ only)." &

wait
```

### Phase 3: Prompt + Execution (Slices 3 & 4 — sequential)

```bash
# Slice 3 — Prompt Composition
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=3 \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -f _docs/plans/meridian-channel/slices/3-prompt-composition.md \
    -p "Implement Slice 3 of meridian-channel. Create prompt composition pipeline using t-strings (PEP 750), optional Jinja2 fallback, skill deduplication, sanitization (strip stale report-path instructions, boundary markers for prior output), and dry-run mode. Correctness specs 2 (context isolation) and 6 (sanitization) must hold. All acceptance criteria must pass."

# Slice 4 — Execution Engine (depends on Slice 3)
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=4 \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -f _docs/plans/meridian-channel/slices/4-execution-engine.md \
    -p "Implement Slice 4 of meridian-channel. Create execution engine with async subprocess management, stdout/stderr streaming, signal forwarding (SIGINT/SIGTERM), finalization guarantee via try/finally (spec 1 — CRITICAL), exit code mapping, timeout support, and permission resolver Protocol. All acceptance criteria must pass."
```

**Review** (high risk — execution engine, finalization guarantee):
```bash
$RUNNER --agent reviewer --model gpt-5.3-codex \
    --session "$SESSION" --label slice=3-4,phase=review,reviewer=codex \
    -f _docs/plans/meridian-channel/slices/3-prompt-composition.md \
    -f _docs/plans/meridian-channel/slices/4-execution-engine.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Review Slices 3-4. Critical check: finalization guarantee (spec 1) — verify try/finally covers ALL paths including signals, timeouts, and exceptions. Also check prompt sanitization (spec 6), context isolation (spec 2)." &

$RUNNER --agent reviewer --model claude-opus-4-6 \
    --session "$SESSION" --label slice=3-4,phase=review,reviewer=opus \
    -f _docs/plans/meridian-channel/slices/3-prompt-composition.md \
    -f _docs/plans/meridian-channel/slices/4-execution-engine.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Review Slices 3-4. Focus on: signal handling edge cases, subprocess cleanup on timeout, t-string composition correctness, prompt injection prevention via boundary markers. Does the execution engine correctly handle every exit code path?" &

$RUNNER --agent reviewer --model claude-sonnet-4-6 \
    --session "$SESSION" --label slice=3-4,phase=review,reviewer=sonnet \
    -f _docs/plans/meridian-channel/slices/4-execution-engine.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Review Slice 4 execution engine. Stress test: what happens if the harness crashes mid-write? What if SIGTERM arrives during finalization? What if SQLite is locked when finalize tries to write? Enumerate failure modes and verify each is handled." &

wait
```

### Phase 4: Extraction + Wiring (Slices 5a & 5b — sequential)

```bash
# Slice 5a — Extraction
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=5a \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/architecture.md \
    -f _docs/plans/meridian-channel/slices/5a-extraction.md \
    -p "Implement Slice 5a of meridian-channel. Create cross-harness token/cost extraction, files-touched extraction, report extraction with fallback (last assistant message when report.md missing), finalize row enrichment, and error classification (retryable vs unrecoverable vs strategy_change). All acceptance criteria must pass."

# Slice 5b — MCP Server + CLI Commands + API Tools
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=5b \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/architecture.md \
    -f _docs/plans/meridian-channel/mcp-tools.md \
    -f _docs/plans/meridian-channel/cli-contract.md \
    -f _docs/plans/meridian-channel/slices/5b-mcp-cli-wiring.md \
    -p "Implement Slice 5b of meridian-channel. Wire FastMCP server with all tool handlers auto-registered from Operation Registry. Wire CLI command handlers for run, space, skills, models, context, diag. Wire DirectAdapter API tool generation from the same registry with allowed_callers: [code_execution_20260120] for programmatic tool calling. run_create is non-blocking in MCP mode (returns RunCreated immediately, agent polls run_show or calls run_wait). CLI run_create blocks until completion. Output formatting: rich (TTY), plain, json, porcelain. All acceptance criteria must pass, especially: all three surfaces auto-registered from registry, surface parity test passes, no business logic in tool/command handlers."
```

**Review** (medium risk — dual surface wiring):
```bash
$RUNNER --agent reviewer --model gpt-5.3-codex \
    --session "$SESSION" --label slice=5a-5b,phase=review,reviewer=codex \
    -f _docs/plans/meridian-channel/slices/5a-extraction.md \
    -f _docs/plans/meridian-channel/slices/5b-mcp-cli-wiring.md \
    -f _docs/plans/meridian-channel/mcp-tools.md \
    -p "Review Slices 5a-5b. Check: CLI/MCP parity table matches actual implementations, non-blocking run_create in MCP, error classification categories, extraction pipeline completeness. Verify no business logic leaked into CLI/MCP handlers." &

$RUNNER --agent reviewer --model claude-opus-4-6 \
    --session "$SESSION" --label slice=5a-5b,phase=review,reviewer=opus \
    -f _docs/plans/meridian-channel/slices/5b-mcp-cli-wiring.md \
    -f _docs/plans/meridian-channel/mcp-tools.md \
    -f _docs/plans/meridian-channel/cli-contract.md \
    -p "Review Slice 5b. Focus on: Operation Registry auto-registration correctness, MCP response types match frozen dataclass definitions, --format flag handling (rich disabled for non-TTY/--json/--porcelain), run_wait timeout behavior." &

wait
```

### Phase 5: Space + Context (Slice 6)

```bash
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=6 \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -f _docs/plans/meridian-channel/mcp-tools.md \
    -f _docs/plans/meridian-channel/slices/6-space-context.md \
    -p "Implement Slice 6 of meridian-channel. Create space CRUD + state machine (active → paused | completed | abandoned), space-summary.md generation, supervisor harness launch (meridian space start stays alive as parent), context pinning (pin/unpin/list with DB tracking), export command, diag repair. Space start must: create DB row, write lock file, set MERIDIAN_WORKSPACE_ID, spawn harness, wait for exit. Resume must: generate summary, re-inject pinned context. All acceptance criteria must pass."
```

**Review** (medium risk):
```bash
$RUNNER --agent reviewer --model gpt-5.3-codex \
    --session "$SESSION" --label slice=6,phase=review,reviewer=codex \
    -f _docs/plans/meridian-channel/slices/6-space-context.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Review Slice 6. Check: space state machine transitions (spec 8), context pinning survives compaction (spec 3), lock file cleanup on exit, MERIDIAN_WORKSPACE_ID propagation, passthrough args forwarded to harness." &

$RUNNER --agent reviewer --model claude-opus-4-6 \
    --session "$SESSION" --label slice=6,phase=review,reviewer=opus \
    -f _docs/plans/meridian-channel/slices/6-space-context.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Review Slice 6. Focus on: what happens if harness crashes during space start? Is the lock file cleaned up? Does resume --fresh correctly start a new harness without session continuation? Is diag repair idempotent?" &

wait
```

### Phase 6: Safety + Migration (Slice 7)

```bash
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label slice=7 \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -f _docs/plans/meridian-channel/risk-and-gaps.md \
    -f _docs/plans/meridian-channel/slices/7-safety-migration.md \
    -p "Implement Slice 7 of meridian-channel. Create permission tiers (read-only, workspace-write, full-access, danger), cost budgets (per-run and per-space with SIGTERM on breach), guardrail scripts (post-run validation), secret redaction (--secret KEY=VALUE redacts from all output), JSONL-to-SQLite migration (meridian migrate, idempotent), skill/agent reference updates (run-agent.sh → meridian run), shell completions (bash/zsh/fish via cyclopts). Also add repo rename step docs (meridian-collab → meridian-channel). All acceptance criteria must pass."
```

**Review** (high risk — security, permissions, migration):
```bash
$RUNNER --agent reviewer --model gpt-5.3-codex \
    --session "$SESSION" --label slice=7,phase=review,reviewer=codex \
    -f _docs/plans/meridian-channel/slices/7-safety-migration.md \
    -f _docs/plans/meridian-channel/risk-and-gaps.md \
    -p "Review Slice 7. Check: permission tier enforcement (no --unsafe = no danger tier), budget SIGTERM timing, secret redaction completeness (check logs, reports, artifacts, DB), migration idempotency." &

$RUNNER --agent reviewer --model claude-opus-4-6 \
    --session "$SESSION" --label slice=7,phase=review,reviewer=opus \
    -f _docs/plans/meridian-channel/slices/7-safety-migration.md \
    -p "Review Slice 7. Focus on: can secrets leak through any path? Check error messages, stack traces, SQLite, JSONL, markdown reports, stderr logs. Is the redaction post-processing pass applied before ANY storage write? Is migration safe to run twice?" &

$RUNNER --agent reviewer --model claude-sonnet-4-6 \
    --session "$SESSION" --label slice=7,phase=review,reviewer=sonnet \
    -f _docs/plans/meridian-channel/slices/7-safety-migration.md \
    -p "Review Slice 7. Enumerate every place a secret value could appear in the system (env vars, process args, stdout, stderr, report.md, output.jsonl, runs.db, runs.jsonl, space-summary.md). Verify redaction covers each one." &

wait
```

### Phase 7: Integration + Final Review

```bash
# Full integration test
$RUNNER --model gpt-5.3-codex \
    --session "$SESSION" --label phase=integration \
    --skills scratchpad \
    -f _docs/plans/meridian-channel/README.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -p "Run integration tests for meridian-channel. Verify: (1) meridian --help shows all commands, (2) meridian run create with mock harness completes and writes all artifacts, (3) meridian serve starts and responds to MCP tool calls, (4) meridian space start/resume lifecycle works, (5) surface parity test passes (all operations exposed to both CLI and MCP), (6) all 10 correctness specs hold. Fix any failures."

# Final cross-model review
$RUNNER --agent reviewer --model claude-opus-4-6 \
    --session "$SESSION" --label phase=final-review \
    -f _docs/plans/meridian-channel/README.md \
    -f _docs/plans/meridian-channel/correctness-specs.md \
    -f _docs/plans/meridian-channel/design-philosophy.md \
    -p "Final review of meridian-channel. Check: (1) all 10 correctness specs hold, (2) SOLID principles followed — SRP in modules, DIP via Protocols, OCP via Operation Registry, (3) no business logic in CLI/MCP handlers, (4) frozen dataclasses in core domain, pydantic only at boundaries, (5) structlog configured, (6) tests exist for all critical paths."

# Commit
$RUNNER --model claude-haiku-4-5 \
    --session "$SESSION" --label phase=commit \
    -p "Stage and commit all meridian-channel implementation files. Use a conventional commit message summarizing the full implementation."
```

## Run-Agent Quick Reference

```bash
RUNNER=".claude/skills/run-agent/scripts/run-agent.sh"
INDEX=".claude/skills/run-agent/scripts/run-index.sh"

# Launch a run
$RUNNER --model MODEL --skills SKILLS -f FILE -p "PROMPT"

# Check results
$INDEX list --session SESSION_ID
$INDEX report @latest
$INDEX files @latest

# Continue/retry
$INDEX continue @latest -p "Fix the failing test"
$INDEX retry @last-failed

# Dry run (preview prompt without executing)
$RUNNER --model MODEL --skills SKILLS --dry-run -p "PROMPT"
```

## Model Selection

| Task | Model | Why |
|------|-------|-----|
| Implementation | `gpt-5.3-codex` | Fast, strong at code generation |
| UI iteration | `claude-sonnet-4-6` | Good at UI/UX refinement loops |
| Architecture review | `claude-opus-4-6` | Subtle correctness, edge cases |
| Multi-perspective review | Fan out across families | Different blind spots |
| Commit messages | `claude-haiku-4-5` | Fast, clean, cheap |

## Orchestrator Checklist

Between each phase:
- [ ] Check `$INDEX list --session "$SESSION"` for failures
- [ ] Read reports: `$INDEX report @latest`
- [ ] If a run failed, check: `$INDEX logs @latest --tools`
- [ ] Retry if retryable: `$INDEX retry @last-failed`
- [ ] Continue if needs adjustment: `$INDEX continue @latest -p "Fix..."`
- [ ] Run tests: verify acceptance criteria before moving to next phase
- [ ] Commit after each successful phase (not after each slice)

## Key Invariants to Monitor

These are the 10 correctness specs — violations are blockers:

1. **Finalization guarantee** — every run writes finalize row (Slice 4)
2. **Context isolation** — runs can't see other runs' context (Slice 3)
3. **Pinned context survives compaction** — re-injected on resume (Slice 6)
4. **Cost tracking accuracy** — within 5% (Slice 5a)
5. **ID uniqueness** — globally unique, unambiguous within scope (Slice 1)
6. **Prompt sanitization** — prior output in boundary markers (Slice 3)
7. **Lock correctness** — no SQLite corruption with parallel writers (Slice 1)
8. **Space state machine** — valid transitions only (Slice 6)
9. **Skill discovery from `.agents/skills/` only** (Slice 2)
10. **Depth limiting** — refuses at `MERIDIAN_DEPTH >= max_depth` (Slice 4)
