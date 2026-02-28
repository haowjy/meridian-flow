# Migration from Rust Plan

**Required reading:**
- [`README.md`](README.md) (always)

This plan supersedes `orchestrate-cli.md` (the Rust plan). Here is what changed and why.

## Language: Rust -> Python 3.14

**Why:** The original plan estimated 18-22 days in Rust. Python reduces this to 12-16 days because:
- No borrow checker, lifetime annotations, or `Send + Sync` bounds to satisfy
- `try/finally` is simpler than `Drop` guards for finalization guarantees
- `asyncio` subprocess management is straightforward vs tokio
- pydantic gives type-safe serialization without `serde` derive boilerplate
- The MCP SDK is Python-native (Anthropic's official `mcp` package)
- `meridian` is I/O-bound (subprocess spawning, SQLite, file I/O) — Rust's performance advantage is irrelevant

**Type safety preserved via:**
- `pyright` strict mode (catches most of what the Rust compiler catches for business logic)
- `@dataclass(frozen=True)` for all core domain types (immutable by default)
- `pydantic` only at boundaries (MCP responses, config parsing — NOT in core domain)
- `NewType` for domain IDs (SpaceId, RunId, etc.)
- `Protocol` for interface contracts (HarnessAdapter, RunStore, SpaceStore, SkillIndex)
- `assert_never` for exhaustive pattern matching on StrEnum/Literal types
- Deferred annotations (PEP 649) for cleaner forward references

## Primary Interface: CLI -> MCP Server + CLI

**Why:** Since the original plan was written, Anthropic released programmatic tool calling and the MCP SDK. Agents no longer need to shell out to `meridian run list --format json` and parse stdout. They call `run_list()` as an MCP tool and get structured JSON back. This is:
- More reliable (no output parsing)
- More composable (tools work in code execution loops)
- Progressive disclosure native (agents call `skills.search()` to discover capabilities)

The CLI remains as the human interface and a fallback agent interface.

## Skill Discovery: Prompt Injection -> MCP Tool Calls

**Why:** The Rust plan injected skill descriptions into the agent's prompt. With MCP, skills are discovered on-demand:
- Agent calls `skills.search("code review")` -> gets names + descriptions
- Agent calls `skills.load("review")` -> gets full content
- No skill descriptions pre-loaded into context by default
- Eliminates context rot from 15 skill descriptions eating tokens

## Architecture Changes

| Aspect | Rust Plan | Python Plan |
|--------|-----------|-------------|
| Language | Rust | Python 3.14 |
| Type checking | Compiler | pyright strict |
| Core domain types | Rust structs | `@dataclass(frozen=True)` |
| Boundary serialization | serde | pydantic (boundaries only) |
| Async runtime | tokio | asyncio + `aiosqlite` (MCP) / `sqlite3` sync (CLI) |
| CLI framework | clap v4 | cyclopts |
| Template engine | minijinja | t-strings (PEP 750) + Jinja2 fallback |
| SQLite | rusqlite (bundled) | `sqlite3` (sync) + `aiosqlite` (async) |
| Primary interface | CLI only | MCP server + CLI (Operation Registry) |
| Anti-drift | N/A | Operation Registry + CI parity test |
| Finalization | `Drop` guard | `try/finally` |
| Logging | N/A | structlog (JSON/pretty) |
| Output formatting | comfy-table, owo-colors | rich (TTY only) |
| Config management | manual TOML | pydantic-settings |
| Distribution | Static binary, cross-compiled | `pip install`, pure Python |
| Trait/Protocol | Rust traits | Python Protocols (structural subtyping) |
| Error handling | thiserror + anyhow | Standard exceptions + error classification |

## Slices: 9 -> 9 (with restructuring)

The Rust plan had 9 slices (0-8). This plan has 9 (0-7, with 5 split into 5a/5b):
- Slices 0-4 map roughly 1:1 but with less effort (no compiler fighting)
- **Slice 5 split into 5a (extraction + error classification) and 5b (MCP + CLI wiring)** — both surfaces built in the same slice to enforce parity from day one
- Slices 7+8 (Safety + Migration) merged into Slice 7 (less distribution work — no cross-compilation)
- CLI command handlers moved from Slice 6 to Slice 5b (same slice as MCP tools — prevents drift)

## What Stayed the Same

- All design principles P1-P11 (adapted for Python, plus new P12 for MCP-first)
- Space/run model, state machine, ID scheme
- Context pinning (P6)
- SQLite WAL schema (identical tables)
- Three base skills (run-agent, agent, orchestrate)
- Model catalog with same models
- All 10 correctness specifications
- Depth limiting via MERIDIAN_DEPTH
- Mock harness for testing (now a Python script)
- Directory layout (`.meridian/`)
- Markdown-first artifact strategy
- Compatibility contract

## What Was Dropped (Rust-specific)

- Cross-compilation matrix (Python is cross-platform by default)
- Binary size optimization (no binary)
- `comfy-table` / `owo-colors` (replaced with `rich`)
- `insta` snapshot testing (replaced with `pytest-snapshot`)
- `assert_cmd` integration testing (replaced with `subprocess` in pytest)
- `blake3` hashing (Python's `hashlib.sha256` is sufficient for dedup keys)
- `fd-lock` crate (replaced with `fcntl.flock`)

## What Was Restored (from Rust plan, initially missing)

Review convergence: all three independent reviews flagged these omissions.

- **Model catalog failure modes** — model not found, alias ambiguous, model deprecated (now in ModelEntry)
- **Open-weight model support** — model routing handles `provider/model` format for OpenCode
- **Space management details** — `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `--autocompact`, passthrough args, harness resume vs fresh start
- **Continuation pattern guidance** — injected into supervisor prompt on space resume
- **Stronger acceptance criteria** — Slice 0 now has 20 criteria (was 13), Slice 6 has 11 (was 13 but more focused)
- **Schema migration nullable-first policy** — new columns always nullable, no backfill in migration
- **`meridian explore` command** — deferred to v2 (see v2 Horizon)
- **`--stream-delay` on mock harness** — simulates slow output for streaming tests
- **MockAdapter for testing** — mock harness responds to configurable flags

## What Was Added (new in Python plan)

- MCP server mode (`meridian serve`) as primary agent interface via FastMCP
- MCP tool definitions with frozen dataclass response types
- **Operation Registry** — anti-drift mechanism, auto-exposes operations to both CLI + MCP
- **CLI/MCP parity contract** — explicit table, CI-enforced test
- **Storage Protocol layer** — `ports.py` with RunStore, RunStoreSync, SpaceStore, SkillIndex, ContextStore
- P12 design principle (MCP-first)
- Non-blocking `run_create` in MCP mode + `run_wait` tool
- t-strings (PEP 750) for prompt composition
- structlog for structured logging
- rich for TTY output formatting
- pydantic-settings for config management
- Error classification (retryable vs unrecoverable) in execution engine
- CLI contract specs (stdout/stderr, --json, --yes, --no-input, error JSON schema)
- Dual sync/async SQLite strategy
- Tool gateway architecture (v2 placeholder — MCP multiplexer)
- Programmatic tool calling compatibility considerations

## v2 Horizon (Not in v1, Architecture Accommodates)

These features are explicitly **not** in v1 but the architecture is designed to support them:

| Feature | Why Deferred | Architecture Hook |
|---------|-------------|-------------------|
| **MCP multiplexer** | Complexity — get orchestration right first | `ToolRegistry` abstraction, `tools.search`/`tools.invoke` tool stubs |
| **`meridian explore`** | Nice-to-have, not MVP | Operation Registry — just add a new operation |
| **Meridian integration** | Meridian would register as an external MCP server | MCP multiplexer gateway |
| **Free-threaded Python** | PEP 779 is experimental in 3.14 | `asyncio` core is compatible; concurrent runs could use threads later |
| **Remote MCP transport** | stdio is sufficient for v1 | FastMCP supports SSE/WebSocket — swap transport later |
| **Plugin system** | Operations are sufficient for v1 | Operation Registry is already plugin-shaped |
| **Web dashboard** | CLI + MCP covers all use cases in v1 | Storage Protocols make it easy to add a web layer |
