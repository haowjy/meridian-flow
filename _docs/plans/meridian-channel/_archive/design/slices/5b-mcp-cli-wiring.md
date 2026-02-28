# Slice 5b: MCP Server + CLI Commands + API Tools (all surfaces)

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always, especially P12)
- [`_docs/plans/meridian-channel/mcp-tools.md`](../mcp-tools.md) (tool definitions, parity contract, non-blocking run_create)
- [`_docs/plans/meridian-channel/cli-contract.md`](../cli-contract.md) (output modes, error schema)
- [`_docs/plans/meridian-channel/architecture.md`](../architecture.md) (operation registry)

**Effort:** 1.5 days
**Dependencies:** Slice 5a (extraction), Slice 2 (skill registry + models), Slice 1 (state layer).
**Model recommendation:** `gpt-5.3-codex`

## Description

Wire up the FastMCP server with all tool handlers from the Operation Registry, wire up CLI command handlers, AND generate Anthropic API tool definitions for programmatic tool calling via `DirectAdapter`. All three surfaces built in the same slice to ensure parity from day one. `run_create` is non-blocking in MCP mode (returns immediately, agent polls or waits).

## Files to create/update

- `src/meridian/server/main.py` — FastMCP server with lifespan, auto-registers tools from registry
- `src/meridian/cli/run.py` — run CLI commands (create, list, show, continue, retry, wait)
- `src/meridian/cli/space.py` — space CLI commands
- `src/meridian/cli/skills_cmd.py` — skills CLI commands
- `src/meridian/cli/models_cmd.py` — models CLI commands
- `src/meridian/cli/context.py` — context CLI commands
- `src/meridian/cli/diag.py` — diagnostics CLI commands
- `src/meridian/cli/output.py` — output formatting: rich (TTY), plain, json, porcelain
- `src/meridian/lib/ops/run.py` — run operations (create, list, show, continue, retry, wait)
- `src/meridian/lib/ops/space.py` — space operations
- `src/meridian/lib/ops/context.py` — context operations
- `src/meridian/lib/ops/diag.py` — diagnostics operations

## MCP server wiring (from Operation Registry)

```python
from mcp.server.fastmcp import FastMCP
from meridian.lib.ops.registry import get_all_operations

mcp = FastMCP("meridian", lifespan=lifespan)

# Auto-register all operations from registry
for op in get_all_operations():
    if not op.cli_only:
        mcp.tool(name=op.mcp_name, description=op.description)(op.handler)
```

## API tool generation (for DirectAdapter / programmatic tool calling)

```python
# meridian/lib/harness/direct.py — tool definitions from same registry
def build_tool_definitions() -> list[dict]:
    tools = [{"type": "code_execution_20260120", "name": "code_execution"}]
    for op in get_all_operations():
        if not op.cli_only:
            tools.append({
                "name": op.mcp_name,
                "description": op.description,
                "input_schema": schema_from_type(op.input_type),
                "allowed_callers": ["code_execution_20260120"],
            })
    return tools
```

The `DirectAdapter` handles the tool-calling loop: send messages to Anthropic API → receive `tool_use` blocks → execute against `meridian.lib.ops` handlers → return `tool_result` → loop until `stop_reason == "end_turn"`. Tool results from programmatic calls don't enter Claude's context — only the final code execution output does.

## Non-blocking `run_create` in MCP mode

```python
# MCP: returns immediately, run executes in background task
@mcp.tool()
async def run_create(...) -> RunCreated:
    run = await stores.run.create(params)
    asyncio.create_task(execute_run(run, stores))
    return RunCreated(run_id=run.id, status="running")

# CLI: blocks until completion (human expects result)
@app.command()
def run_create(...) -> None:
    result = sync_execute_run(params)  # blocking, uses sqlite3 sync
    output.print_run_result(result)
```

## Acceptance criteria

1. `meridian serve` starts and responds to all MCP tool calls
2. MCP tools auto-registered from Operation Registry
3. `run_create` is non-blocking in MCP mode (returns RunCreated immediately)
4. `run_wait` blocks until run completes or timeout
5. All CLI commands work with `--format` (plain/json/wide/porcelain)
6. CLI, MCP, and API tool surfaces pass `test_surface_parity.py`
7. MCP tools call `meridian.lib.ops` — no business logic in tool handlers
8. CLI commands call `meridian.lib.ops` — no business logic in command handlers
8b. `DirectAdapter.build_tool_definitions()` generates valid API tool defs with `allowed_callers: ["code_execution_20260120"]`
9. Integration tests for MCP tools using `mcp` SDK test client
10. Snapshot tests for MCP response schemas
11. `rich` output disabled for non-TTY, `--json`, `--porcelain`
