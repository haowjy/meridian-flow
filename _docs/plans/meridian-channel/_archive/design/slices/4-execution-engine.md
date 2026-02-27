# Slice 4: Execution Engine

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always, especially P7)
- [`_docs/plans/meridian-channel/correctness-specs.md`](../correctness-specs.md) (Spec 1: finalization guarantee)

**Effort:** 2 days
**Dependencies:** Slice 3 (prompt composition), Slice 2 (HarnessAdapter), Slice 1 (state layer).
**Model recommendation:** `gpt-5.3-codex`

## Description

Implement harness command building via `HarnessAdapter.build_command()`, asyncio-based process spawning with stdout/stderr streaming, signal handling with proper cleanup, and graceful shutdown with finalization guarantee. Fixes gap #1 (background finalize).

## Files to create

- `src/meridian/lib/exec/spawn.py` — asyncio subprocess spawn with streaming
- `src/meridian/lib/exec/signals.py` — signal handling, graceful shutdown
- `src/meridian/lib/exec/timeout.py` — timeout support

## Key design decisions

**Finalization guarantee (fix gap #1):**
```python
async def execute_with_finalization(
    run: Run,
    state: StateDB,
    artifacts: ArtifactStore,
    registry: HarnessRegistry,
) -> int:
    """Execute a run with guaranteed finalization via try/finally."""
    state.append_start_row(run)
    exit_code = 1
    try:
        exit_code = await spawn_and_stream(run, artifacts, registry)
    except asyncio.CancelledError:
        exit_code = 130
    except TimeoutError:
        exit_code = 3
    except Exception:
        exit_code = 2
    finally:
        # ALWAYS writes — even on signal, exception, OOM
        state.append_finalize_row(run.id, exit_code=exit_code, duration=elapsed)
    return exit_code
```

Python's `try/finally` is simpler than Rust's `Drop` guard but equally reliable for this purpose. The `finally` block writes a minimal finalize row (exit code, duration, status). Slice 5a enriches it afterward.

**Permission handling:** Slice 4 defines the `PermissionResolver` Protocol. Slice 7 implements concrete tiers. Until then, `SafeDefault` is used.

**Exit code mapping:** 0 = success, 1 = agent error, 2 = infrastructure error, 3 = timeout, 130 = SIGINT, 143 = SIGTERM.

## Acceptance criteria

1. CLI command built via `HarnessAdapter.build_command()`
2. Process spawned asynchronously with `asyncio.create_subprocess_exec`
3. Stderr streamed to terminal in real-time AND captured to file
4. Stdout captured to output.jsonl via ArtifactStore
5. SIGINT/SIGTERM forwarded to child process with graceful shutdown
6. Finalize row ALWAYS written, even on signal, exception, timeout (fix gap #1)
7. Timeout kills child after configured duration
8. Exit codes match documented semantics
9. Integration test: spawn mock harness, verify finalization on kill
