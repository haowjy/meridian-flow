# Slice 0: Scaffold, CI, and `meridian` Package

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always)
- [`_docs/plans/meridian-channel/architecture.md`](../architecture.md) (project layout, pyproject.toml, operation registry)

**Effort:** 1 day
**Dependencies:** None (first slice).
**Model recommendation:** `gpt-5.3-codex`

## Description

Set up the Python package structure, pyproject.toml, cyclopts CLI skeleton with resource-first subcommand groups stubbed, FastMCP server skeleton, Operation Registry scaffold, CI pipeline, and domain types (frozen dataclasses). After this slice, agents can invoke `meridian --help` and `meridian serve` starts (but has no tools). Surface parity test is in place from day one.

## Required reading (`-f` files for orchestrator)

- `_docs/plans/meridian-channel/README.md`
- `_docs/plans/meridian-channel/architecture.md`
- `.claude/skills/run-agent/scripts/run-agent.sh` (CLI interface being replaced)
- `.claude/skills/run-agent/SKILL.md` (current interface contract)

## Files to create

- `meridian-channel/pyproject.toml` — package config, dependencies, entry points
- `src/meridian/__init__.py` — package init, version
- `src/meridian/__main__.py` — `python -m meridian` entry point
- `src/meridian/cli/__init__.py`
- `src/meridian/cli/main.py` — cyclopts app with resource-first groups (built from registry)
- `src/meridian/server/__init__.py`
- `src/meridian/server/main.py` — FastMCP server skeleton with lifespan (no tools yet)
- `src/meridian/lib/__init__.py`
- `src/meridian/lib/types.py` — domain newtypes (SpaceId, RunId, HarnessId, ModelId) as NewType
- `src/meridian/lib/domain.py` — frozen dataclasses for core domain types
- `src/meridian/lib/ports.py` — Storage Protocol interfaces
- `src/meridian/lib/ops/registry.py` — Operation Registry scaffold
- `src/meridian/lib/logging.py` — structlog configuration
- `meridian-channel/tests/__init__.py`
- `meridian-channel/tests/conftest.py` — shared fixtures
- `meridian-channel/tests/test_cli_smoke.py` — smoke test: `meridian --help` exits 0
- `meridian-channel/tests/mock_harness.py` — configurable mock harness script
- `meridian-channel/tests/fixtures/` — test skill/agent files
- `.github/workflows/meridian-ci.yml` — lint (ruff), typecheck (pyright), test (pytest)

## Mock harness (`mock_harness.py`)

A Python script that simulates harness behavior for integration tests:
```bash
python mock_harness.py --exit-code 0 --duration 2 --tokens '{"input": 1500, "output": 800}'
python mock_harness.py --exit-code 1 --stderr "Error: context window exceeded"
python mock_harness.py --hang
python mock_harness.py --write-report "Task completed successfully" --report-dir /path/to/run/
python mock_harness.py --crash-after-lines 50 --stdout-file fixtures/partial.jsonl
```

## Domain newtypes

```python
from typing import NewType

SpaceId = NewType("SpaceId", str)   # "w1", "w2", "w3"
RunId = NewType("RunId", str)               # "r1", "w3/r1"
HarnessId = NewType("HarnessId", str)       # "claude", "codex", "opencode"
ModelId = NewType("ModelId", str)            # "claude-opus-4-6", "gpt-5.3-codex"
```

## Acceptance criteria

1. `uv sync` installs all dependencies (Python 3.14 required)
2. `meridian --help` prints resource-first subcommand groups
3. `meridian --version` prints version
4. `meridian serve` starts FastMCP server (exits cleanly on EOF)
5. `ruff check .` passes
6. `pyright` passes in strict mode
7. `pytest` passes (smoke test + surface parity test)
8. CI workflow runs on PR and passes (Python 3.14 matrix)
9. Resource-first subcommand groups stubbed: `serve`, `space`, `run`, `skills`, `models`, `context`, `diag`, `export`, `migrate`
10. Top-level aliases wired: `start` -> `space start`, `run` (with `-p`) -> `run create`, etc.
11. Domain newtypes defined in `meridian/lib/types.py`
12. Core domain types as frozen dataclasses in `meridian/lib/domain.py`
13. Storage Protocols defined in `meridian/lib/ports.py` (both `RunStore` async and `RunStoreSync` sync variants)
14. Operation Registry scaffold in `meridian/lib/ops/registry.py` with at least one stub operation and duplicate-name guard
15. `test_surface_parity.py` passes (verifies all registry ops have both CLI + MCP exposure)
16. structlog configured in `meridian/lib/logging.py`
17. `mock_harness.py` responds to `--exit-code`, `--duration`, `--hang`, `--stdout-file`, `--crash-after-lines`, `--stream-delay` flags
18. Test fixtures directory contains sample SKILL.md and agent .md files
19. `--json` / `--format json` flag wired (outputs to stdout only)
20. `--yes` / `--no-input` flags wired at top level
