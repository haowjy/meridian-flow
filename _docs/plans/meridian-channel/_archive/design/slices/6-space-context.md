# Slice 6: Space Launcher + Context Pinning + Advanced CLI

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always, especially P5-P6)
- [`_docs/plans/meridian-channel/architecture.md`](../architecture.md) (project layout)
- [`_docs/plans/meridian-channel/mcp-tools.md`](../mcp-tools.md) (space + context tools)

**Effort:** 2 days
**Dependencies:** Slice 1 (state layer), Slice 5b (MCP server + CLI commands).
**Model recommendation:** `gpt-5.3-codex`

## Description

Implement space launcher logic (the `meridian start`/`resume` lifecycle), context pinning, export command, and `diag repair`. CLI command handlers were wired in Slice 5b; this slice adds the space-specific business logic. Fixes gaps #5, #6, #7.

## Files to create

- `src/meridian/lib/space/crud.py` — space CRUD + state machine
- `src/meridian/lib/space/summary.py` — space-summary.md generation
- `src/meridian/lib/space/launch.py` — supervisor harness launch
- `src/meridian/lib/space/context.py` — context pinning logic
- `src/meridian/cli/export.py` — export CLI command handler

## Key design decisions

Type-safe filtering (fix gap #7):
```python
@dataclass
class RunListFilters:
    model: str | None = None
    space: str | None = None
    no_space: bool = False
    status: str | None = None
    failed: bool = False
    limit: int = 20
# Translated to parameterized SQL — no string interpolation
```

Space launcher (`meridian space start`):
1. Create `spaces` row with status `active`, generate SpaceId
2. Write `.meridian/active-spaces/<cid>.lock` (PID file)
3. Set `MERIDIAN_WORKSPACE_ID` in child env
4. Spawn harness as child process (`meridian start` stays alive as parent)
5. Wait for harness exit -> finalize space

Context pinning:
```python
async def pin(space_id: SpaceId, file_path: str) -> None:
    """Pin file to space context. Emits ContextPinned event."""
    ...

async def unpin(space_id: SpaceId, file_path: str) -> None:
    """Unpin file. Emits ContextUnpinned event."""
    ...

async def get_pinned(space_id: SpaceId) -> list[PinnedFile]:
    """List pinned files for space."""
    ...

async def inject_pinned_context(space_id: SpaceId) -> str:
    """Load and concatenate all pinned file contents for prompt injection."""
    ...
```

## Space launcher details (restored from Rust plan)

- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `--autocompact` passthrough to harness
- Passthrough args for harness-specific flags not modeled by meridian
- Continuation: `meridian resume` vs `meridian resume --fresh` (harness resume vs fresh start)
- Continuation pattern guidance injected into supervisor prompt on resume

## Acceptance criteria

1. `meridian space start` creates space, sets env vars, spawns harness
2. `meridian space resume` generates summary, re-injects pinned context
3. `meridian space resume --fresh` starts fresh harness (no session continuation)
4. Space state machine enforced (active -> paused | completed | abandoned)
5. `meridian run continue` works for completed, failed, AND running status runs (fix gap #6)
6. `meridian diag repair` validates and fixes index corruption (fix gap #5)
7. `meridian context pin/unpin/list` works with space scoping
8. Pinned files tracked in DB, re-injected on resume (P6)
9. `meridian export` gathers committable markdown artifacts
10. Passthrough args forwarded to harness
11. Integration tests for space lifecycle
