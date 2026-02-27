# MCP Tool Definitions

**Required reading:**
- [`README.md`](README.md) (always)
- [`design-philosophy.md`](design-philosophy.md) (always)
- [`architecture.md`](architecture.md) (operation registry, storage protocols)

## Response Design: Keep It Lean, Markdown for Content

MCP serializes everything as JSON at the transport layer — we can't avoid that. But we control what goes *inside* the responses, and the primary consumer is an LLM. JSON is token-inefficient compared to markdown/plain text, so:

- **Keep response types flat and small.** A `RunSummary` has 7 scalar fields — the JSON overhead is negligible. Don't add nested objects or arrays unless truly necessary.
- **Content fields are markdown, not structured data.** `report`, `report_summary`, `workspace_summary` — these are markdown strings, not JSON sub-objects. The LLM reads them natively.
- **Don't duplicate what markdown already provides.** If the agent needs a full report, it reads `report.md` from disk. The MCP tool returns a path + short summary, not the full content by default.
- **Avoid returning large lists.** `run_list` defaults to 20 items with filters. If an agent needs to understand 50 runs, it should use `workspace_show` for an aggregated summary, not paginate through `run_list`.

The real token cost is always in report bodies and prompt content, not in the `{}` and `""` characters around 7-field structs. Keep the structs small and the content markdown.

## CLI/MCP/API Parity Contract

Every operation must be explicitly listed. Drift is a **CI failure**. Three surfaces are auto-generated from the Operation Registry: CLI commands, MCP tools, and API tool definitions (for programmatic tool calling via `DirectAdapter`).

| Operation | CLI Command | MCP Tool | API Tool | Surface |
|-----------|------------|----------|----------|---------|
| `run.create` | `meridian run create` | `run_create` | `run_create` | All |
| `run.list` | `meridian run list` | `run_list` | `run_list` | All |
| `run.show` | `meridian run show` | `run_show` | `run_show` | All |
| `run.continue` | `meridian run continue` | `run_continue` | `run_continue` | All |
| `run.retry` | `meridian run retry` | `run_retry` | `run_retry` | All |
| `run.wait` | `meridian run wait` | `run_wait` | `run_wait` | All |
| `skills.search` | `meridian skills search` | `skills_search` | `skills_search` | All |
| `skills.load` | `meridian skills show` | `skills_load` | `skills_load` | All |
| `skills.list` | `meridian skills list` | `skills_list` | `skills_list` | All |
| `skills.reindex` | `meridian skills reindex` | `skills_reindex` | `skills_reindex` | All |
| `models.list` | `meridian models list` | `models_list` | `models_list` | All |
| `models.show` | `meridian models show` | `models_show` | `models_show` | All |
| `workspace.start` | `meridian workspace start` | `workspace_start` | `workspace_start` | All |
| `workspace.resume` | `meridian workspace resume` | `workspace_resume` | `workspace_resume` | All |
| `workspace.list` | `meridian workspace list` | `workspace_list` | `workspace_list` | All |
| `workspace.show` | `meridian workspace show` | `workspace_show` | `workspace_show` | All |
| `workspace.close` | `meridian workspace close` | `workspace_close` | `workspace_close` | All |
| `context.pin` | `meridian context pin` | `context_pin` | `context_pin` | All |
| `context.unpin` | `meridian context unpin` | `context_unpin` | `context_unpin` | All |
| `context.list` | `meridian context list` | `context_list` | `context_list` | All |
| `diag.doctor` | `meridian diag doctor` | `diag_doctor` | `diag_doctor` | All |
| `diag.repair` | `meridian diag repair` | `diag_repair` | `diag_repair` | All |
| `serve` | `meridian serve` | — | — | CLI-only (it IS the MCP server) |
| `export` | `meridian export` | — | — | CLI-only (human workflow) |
| `migrate` | `meridian migrate` | — | — | CLI-only (one-time migration) |

## MERIDIAN_DEPTH in MCP Context

When `meridian serve` runs inside a workspace, `MERIDIAN_DEPTH` is read from the environment and incremented for each `run_create` tool call. The MCP server enforces the same depth limit as the CLI — agents calling `run_create` at max depth receive a structured error:

```json
{
  "error": "max_depth_exceeded",
  "message": "Max agent depth (3) reached. Complete this task directly.",
  "current_depth": 3,
  "max_depth": 3
}
```

## Non-Blocking `run_create` MCP Tool

**Critical design decision:** `run_create` in MCP mode is **non-blocking**. It returns immediately with a run ID. The agent polls `run_show` or calls `run_wait` to get results.

**Why:** A blocking `run_create` ties up the MCP connection for the entire run duration (potentially minutes). This prevents the agent from doing other work, checking other runs, or responding to the supervisor.

```python
@mcp.tool()
async def run_create(...) -> RunCreated:
    """Create and start a new agent run. Returns immediately with run ID."""
    run = await stores.run.create(params)
    asyncio.create_task(execute_run(run, stores))  # fire-and-forget
    return RunCreated(run_id=run.id, status="running", message="Run started")

@mcp.tool()
async def run_wait(run_id: str, timeout_secs: int = 600) -> RunResult:
    """Wait for a run to complete. Returns full result."""
    ...
```

## Core Tool Definitions

These are the MCP tools that `meridian serve` exposes. Each tool is auto-registered from the Operation Registry. Input/output types are frozen dataclasses in the core; pydantic serialization is applied only at the MCP boundary. Tools are designed for composability in programmatic tool calling loops.

```python
# ── Run management ──────────────────────────────────────────────
@server.tool()
async def run_create(
    prompt: str,
    model: str = "claude-opus-4-6",
    skills: list[str] | None = None,
    files: list[str] | None = None,
    agent: str | None = None,
    name: str | None = None,
    timeout_secs: int | None = None,
    budget_usd: float | None = None,
    workspace: str | None = None,     # override MERIDIAN_WORKSPACE_ID
) -> RunCreated:
    """Create and start a new agent run. Returns immediately (non-blocking).
    Use run_wait() or poll run_show() to get results."""
    ...

@server.tool()
async def run_wait(
    run_id: str,
    timeout_secs: int = 600,
) -> RunResult:
    """Wait for a run to complete. Returns full result when done."""
    ...

@server.tool()
async def run_list(
    workspace: str | None = None,
    status: str | None = None,
    model: str | None = None,
    limit: int = 20,
    no_workspace: bool = False,
) -> list[RunSummary]:
    """List runs with optional filters. Returns structured JSON."""
    ...

@server.tool()
async def run_show(
    run_id: str,
    include_report: bool = False,
    include_files: bool = False,
) -> RunDetail:
    """Show details for a specific run."""
    ...

@server.tool()
async def run_continue(
    run_id: str,
    prompt: str,
) -> RunResult:
    """Continue a previous run's conversation."""
    ...

@server.tool()
async def run_retry(
    run_id: str,
    prompt: str | None = None,
) -> RunResult:
    """Retry a failed run with clean prompt."""
    ...

# ── Skill discovery (progressive disclosure) ────────────────────
@server.tool()
async def skills_search(
    query: str,
) -> list[SkillSummary]:
    """Search for skills by keyword/tag. Returns name + description, not full content."""
    ...

@server.tool()
async def skills_load(
    skill_id: str,
) -> SkillContent:
    """Load full skill content for injection into a run."""
    ...

@server.tool()
async def skills_list() -> list[SkillSummary]:
    """List all available skills."""
    ...

@server.tool()
async def skills_reindex() -> IndexReport:
    """Re-scan .agents/skills/ and rebuild the skill index."""
    ...

# ── Model catalog ───────────────────────────────────────────────
@server.tool()
async def models_list(
    show_defaults: bool = False,
) -> list[ModelEntry]:
    """List available models with guidance and cost tier."""
    ...

@server.tool()
async def models_show(
    model: str,
) -> ModelDetail:
    """Show full detail for a model (aliases resolved)."""
    ...

# ── Workspace management ────────────────────────────────────────
@server.tool()
async def workspace_start(
    name: str | None = None,
    plan: str | None = None,
) -> WorkspaceCreated:
    """Create a new workspace and launch supervisor harness."""
    ...

@server.tool()
async def workspace_resume(
    workspace: str | None = None,
    fresh: bool = False,
) -> WorkspaceResumed:
    """Resume an existing workspace."""
    ...

@server.tool()
async def workspace_list(
    limit: int = 10,
) -> list[WorkspaceSummary]:
    """List all workspaces with status/cost."""
    ...

@server.tool()
async def workspace_show(
    workspace: str,
) -> WorkspaceDetail:
    """Show workspace detail: runs, cost, pinned files."""
    ...

@server.tool()
async def workspace_close(
    workspace: str,
) -> WorkspaceClosed:
    """Mark a workspace as complete."""
    ...

# ── Context pinning ─────────────────────────────────────────────
@server.tool()
async def context_pin(
    file_path: str,
    workspace: str | None = None,
) -> PinResult:
    """Pin a file to workspace context (survives compaction)."""
    ...

@server.tool()
async def context_unpin(
    file_path: str,
    workspace: str | None = None,
) -> UnpinResult:
    """Unpin a file from workspace context."""
    ...

@server.tool()
async def context_list(
    workspace: str | None = None,
) -> list[PinnedFile]:
    """List pinned files for a workspace."""
    ...

# ── Diagnostics ─────────────────────────────────────────────────
@server.tool()
async def diag_doctor() -> DiagReport:
    """Health check — validate environment, DB, harnesses."""
    ...

@server.tool()
async def diag_repair() -> RepairReport:
    """Validate and fix index corruption, recover stuck runs."""
    ...
```

## Response Types (frozen dataclasses — core domain)

Core domain types are **frozen dataclasses** — immutable, no pydantic dependency. Pydantic serialization is applied only at the MCP/CLI boundary layer.

```python
from dataclasses import dataclass

@dataclass(frozen=True)
class TokenUsage:
    input_tokens: int | None
    output_tokens: int | None
    total_cost_usd: float | None
    source: str           # reported | estimated | unavailable

@dataclass(frozen=True)
class RunCreated:
    """Returned by non-blocking run_create."""
    run_id: str
    status: str          # running
    message: str

@dataclass(frozen=True)
class RunResult:
    run_id: str
    status: str          # completed | failed
    exit_code: int
    duration_secs: float
    report_path: str     # path to report.md
    report_summary: str  # first 500 chars of report
    tokens: TokenUsage | None
    cost_usd: float | None

@dataclass(frozen=True)
class RunSummary:
    run_id: str
    name: str | None
    status: str
    model: str
    run_type: str
    duration_secs: float | None
    cost_usd: float | None

@dataclass(frozen=True)
class RunDetail:
    run_id: str
    name: str | None
    status: str
    model: str
    harness: str
    run_type: str
    skills: tuple[str, ...]      # immutable
    started_at: str
    finished_at: str | None
    duration_secs: float | None
    tokens: TokenUsage | None
    cost_usd: float | None
    report: str | None           # if include_report=True
    files_touched: tuple[str, ...] | None  # if include_files=True

@dataclass(frozen=True)
class SkillSummary:
    name: str
    description: str
    tags: tuple[str, ...]

@dataclass(frozen=True)
class SkillContent:
    name: str
    description: str
    content: str          # full SKILL.md body

@dataclass(frozen=True)
class ModelEntry:
    model_id: str
    aliases: tuple[str, ...]
    role: str
    strengths: str
    cost_tier: str
    harness: str
    # Model catalog failure modes (restored from Rust plan):
    # - Model not found -> clear error + suggestion
    # - Model alias ambiguous -> list candidates
    # - Model deprecated -> warning + redirect
```

## Future: Tool Gateway (v2, not v1)

In v2, `meridian` becomes an MCP multiplexer — external MCP servers register through `meridian`, and agents discover/invoke their tools through `meridian`'s progressive disclosure model:

```python
# v2 — NOT implemented in v1, but architecture accommodates it
@server.tool()
async def tools_search(query: str) -> list[ToolSummary]:
    """Search all registered tools across all MCP servers."""
    ...

@server.tool()
async def tools_invoke(server_id: str, tool_name: str, args: dict) -> Any:
    """Invoke a tool on a registered external MCP server."""
    ...
```

v1 exposes only `meridian`'s own tools. The architecture uses a `ToolRegistry` abstraction that can later include external MCP server tools.
