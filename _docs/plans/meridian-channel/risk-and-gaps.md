# Risk Assessment and Gap Resolution

## Risk Assessment


| Risk                                    | Likelihood      | Impact | Mitigation                                                                |
| --------------------------------------- | --------------- | ------ | ------------------------------------------------------------------------- |
| asyncio signal handling edge cases      | Medium          | High   | Extensive integration tests with mock harness                             |
| MCP SDK breaking changes                | Low             | Medium | Pin SDK version, isolate behind FastMCP layer                             |
| Harness output format changes           | Medium          | Medium | HarnessAdapter Protocol isolates breakage                                 |
| pyright strict mode friction            | Medium          | Low    | Address incrementally; `# type: ignore` with comment for known SDK issues |
| Python subprocess performance vs Rust   | Low             | Low    | Subprocess overhead dominated by harness runtime; negligible              |
| JSONL dual-write correctness            | Low             | Medium | Integration tests, dual-write behind config flag                          |
| CLI/MCP drift                           | Low (mitigated) | High   | Operation Registry + CI parity test — drift is a build failure            |
| cyclopts Python 3.14 compatibility      | Low             | Medium | Run CI matrix on 3.14 immediately; Typer as fallback                      |
| t-strings (PEP 750) maturity            | Low             | Low    | Jinja2 fallback for file-based templates; t-strings for inline only       |
| Non-blocking run_create race conditions | Medium          | Medium | Run state machine in SQLite; `run_wait` polls DB, not in-memory           |
| ID generation race under concurrency    | Low             | High   | SQLite `RETURNING` for counter increment; test with 100 parallel runs     |


## Gap Resolution Tracking


| Gap # | Description                         | Fixed In    | How                                          |
| ----- | ----------------------------------- | ----------- | -------------------------------------------- |
| 1     | Background runs don't finalize      | Slice 4     | `try/finally` + signal handling              |
| 2     | Read/write lock mismatch            | Slice 1     | SQLite WAL + `fcntl.flock`                   |
| 3     | Dangerous permission defaults       | Slice 7     | Permission tiers, `--unsafe` required        |
| 4     | No cost tracking for Codex/OpenCode | Slice 5 + 7 | Cross-harness extraction + budgets           |
| 5     | Index corruption no recovery        | Slice 1 + 6 | SQLite WAL + `diag repair` command           |
| 6     | Crashed runs can't continue         | Slice 6     | Allow "running" status, recover first        |
| 7     | jq injection in filters             | Slice 6     | Typed dataclasses + parameterized SQL        |
| 8     | Skill policy name mismatch          | Slice 7     | Rename skill directories                     |
| 9     | Retry injects stale instructions    | Slice 3     | `strip_stale_report_paths()`                 |
| 10    | Prompt injection across runs        | Slice 3 + 7 | Boundary markers + `sanitize_prior_output()` |


## Open Gaps

### Security (see [security-hardening.md](security-hardening.md))

| ID | Severity | Description |
|----|----------|-------------|
| SEC-1 | **CRITICAL** | Guardrail env leaks secrets (Gap 11) |
| SEC-2 | **CRITICAL** | TTY workspace launch bypasses env sanitization |
| SEC-3 | **CRITICAL** | Context pinning allows out-of-repo file read |
| SEC-4 | MAJOR | `--unsafe` bypassed for danger-full-access sandbox |
| SEC-5 | MAJOR | Harness passthrough args override permission safety |
| SEC-6 | MAJOR | MCP `repo_root` unsandboxed |
| SEC-7 | MAJOR | Arbitrary file read via run references |
| SEC-8 | MAJOR | API credentials not auto-redacted in artifacts |
| SEC-9 | MAJOR | Wildcard MCP tool names accepted |
| SEC-10 | MAJOR | Pinned context injected without containment markers |
| SEC-11 | MINOR | SQLite connection hardening inconsistent |

### Code Quality (see [code-quality.md](code-quality.md))

| ID | Severity | Description |
|----|----------|-------------|
| CQ-1 | MAJOR | SQLite adapter oversized (1,005 LOC) |
| CQ-2 | MAJOR | `execute_with_finalization` oversized |
| CQ-3 | MAJOR | `ops/config.py` mixed concerns |
| CQ-4 | HIGH | `lib/ops` imports CLI format helpers (inverted layering) |
| CQ-5 | MEDIUM | CLI imports server at module level |
| CQ-6 | MEDIUM | Config depends on state/ops (wrong direction) |
| CQ-7 | MEDIUM | Registry sync_handler bypassed by CLI |
| CQ-8 | MEDIUM | Raw sqlite3.connect bypasses store abstractions |
| CQ-9 | MAJOR | Import-time side effects |
| CQ-15 | MEDIUM | HarnessAdapter leaks for DirectAdapter |
| CQ-16 | MINOR | Run lineage fields unused |

### Test Coverage (see [test-coverage.md](test-coverage.md))

| ID | Severity | Description |
|----|----------|-------------|
| TC-1 | MAJOR | Guardrail env isolation test missing |
| TC-2 | MAJOR | TTY execvp branch untested |
| TC-3 | MAJOR | DirectAdapter execute/tool loop untested |

### DX (see [dx-improvements.md](dx-improvements.md))

| ID | Severity | Description |
|----|----------|-------------|
| DX-1 | HIGH | MCP docs don't match tool schemas |
| DX-2 | HIGH | Unknown command shows misleading error |
| DX-3 | MEDIUM | CLI help lacks flag descriptions |
| DX-4 | MEDIUM | Docs claim features that don't exist |
| DX-5 | MEDIUM | TimeoutError not caught at CLI level |
| DX-7 | MEDIUM | Skill authoring hidden constraints |

### Workspace Lifecycle (see [workspace-lifecycle.md](workspace-lifecycle.md))

| ID | Severity | Description |
|----|----------|-------------|
| WL-1 | MAJOR | No Python hook handlers |
| WL-2 | MAJOR | No explicit session tracking on resume |
| WL-3 | MAJOR | No compaction re-injection |
| WL-5 | MINOR | Summary regenerated on every resume |

### Strategic (see [strategic-direction.md](strategic-direction.md))

Direction: "orchestrator for agent orchestrators" — coordinate harnesses, don't replace them.

## Compatibility Contract


| Contract                               | Stable?             | Notes                                                  |
| -------------------------------------- | ------------------- | ------------------------------------------------------ |
| MCP tool response schemas              | **Yes** — versioned | frozen dataclasses, pydantic serialization at boundary |
| `--format json` output schema          | **Yes** — versioned | Schema changes only via version bump                   |
| `--porcelain` plain-text format        | **Yes**             | Fixed column layout                                    |
| Exit codes (0, 1, 2, 3, 130, 143)      | **Yes**             | Semantic meaning documented                            |
| `MERIDIAN_WORKSPACE_ID` env var        | **Yes**             | Process-tree scoping                                   |
| `MERIDIAN_DEPTH` env var               | **Yes**             | Agent depth tracking                                   |
| `.agents/skills/` directory convention | **Yes**             | Canonical skill location                               |
| SQLite schema                          | **No** — internal   | Use CLI/MCP for external integration                   |
| Plain text output (default)            | **No**              | Human-oriented                                         |


