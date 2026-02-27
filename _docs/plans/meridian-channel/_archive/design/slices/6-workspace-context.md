# Slice 6: Workspace Launcher + Context Pinning + Advanced CLI

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always, especially P5-P6)
- [`_docs/plans/meridian-channel/architecture.md`](../architecture.md) (project layout)
- [`_docs/plans/meridian-channel/mcp-tools.md`](../mcp-tools.md) (workspace + context tools)

**Effort:** 2 days
**Dependencies:** Slice 1 (state layer), Slice 5b (MCP server + CLI commands).
**Model recommendation:** `gpt-5.3-codex`

## Description

Implement workspace launcher logic (the `meridian start`/`resume` lifecycle), context pinning, export command, and `diag repair`. CLI command handlers were wired in Slice 5b; this slice adds the workspace-specific business logic. Fixes gaps #5, #6, #7.

## Files to create

- `src/meridian/lib/workspace/crud.py` — workspace CRUD + state machine
- `src/meridian/lib/workspace/summary.py` — workspace-summary.md generation
- `src/meridian/lib/workspace/launch.py` — supervisor harness launch
- `src/meridian/lib/workspace/context.py` — context pinning logic
- `src/meridian/cli/export.py` — export CLI command handler

## Key design decisions

Type-safe filtering (fix gap #7):
```python
@dataclass
class RunListFilters:
    model: str | None = None
    workspace: str | None = None
    no_workspace: bool = False
    status: str | None = None
    failed: bool = False
    limit: int = 20
# Translated to parameterized SQL — no string interpolation
```

Workspace launcher (`meridian workspace start`):
1. Create `workspaces` row with status `active`, generate WorkspaceId
2. Write `.meridian/active-workspaces/<cid>.lock` (PID file)
3. Set `MERIDIAN_WORKSPACE_ID` in child env
4. Spawn harness as child process (`meridian start` stays alive as parent)
5. Wait for harness exit -> finalize workspace

Context pinning:
```python
async def pin(workspace_id: WorkspaceId, file_path: str) -> None:
    """Pin file to workspace context. Emits ContextPinned event."""
    ...

async def unpin(workspace_id: WorkspaceId, file_path: str) -> None:
    """Unpin file. Emits ContextUnpinned event."""
    ...

async def get_pinned(workspace_id: WorkspaceId) -> list[PinnedFile]:
    """List pinned files for workspace."""
    ...

async def inject_pinned_context(workspace_id: WorkspaceId) -> str:
    """Load and concatenate all pinned file contents for prompt injection."""
    ...
```

## Workspace launcher details (restored from Rust plan)

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `--autocompact` passthrough to harness
- Passthrough args for harness-specific flags not modeled by meridian
- Continuation: `meridian resume` vs `meridian resume --fresh` (harness resume vs fresh start)
- Continuation pattern guidance injected into supervisor prompt on resume

## Acceptance criteria

1. `meridian workspace start` creates workspace, sets env vars, spawns harness
2. `meridian workspace resume` generates summary, re-injects pinned context
3. `meridian workspace resume --fresh` starts fresh harness (no session continuation)
4. Workspace state machine enforced (active -> paused | completed | abandoned)
5. `meridian run continue` works for completed, failed, AND running status runs (fix gap #6)
6. `meridian diag repair` validates and fixes index corruption (fix gap #5)
7. `meridian context pin/unpin/list` works with workspace scoping
8. Pinned files tracked in DB, re-injected on resume (P6)
9. `meridian export` gathers committable markdown artifacts
10. Passthrough args forwarded to harness
11. Integration tests for workspace lifecycle
