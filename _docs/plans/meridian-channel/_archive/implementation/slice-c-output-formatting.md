**Status:** approved

# Slice C: Output Formatting Overhaul

## Approved Design Decisions

1. **Default format**: Compact columnar with `format_text()` method on each output dataclass
2. **Help text**: Always `PlainFormatter` — `App(help_formatter="plain")`
3. **Drop `--rich`**: Simplify `OutputFormat` to `text | json | porcelain`
4. **Format location**: Method on each dataclass (colocated with data)

## Implementation Plan

### Step 1: Simplify OutputFormat and emit()

**File: `src/meridian/cli/output.py`**

- Change `OutputFormat = Literal["text", "json", "porcelain"]` (drop "rich", "plain")
- Remove `_emit_rich()` and `_emit_plain()` entirely
- Add `TextFormattable` protocol:
  ```python
  from typing import Protocol, runtime_checkable

  @runtime_checkable
  class TextFormattable(Protocol):
      def format_text(self) -> str: ...
  ```
- Update `emit()`:
  ```python
  def emit(value: Any, config: OutputConfig) -> None:
      if config.format == "json":
          print(json.dumps(_to_json_value(value), sort_keys=True))
      elif config.format == "porcelain":
          _emit_porcelain(value)
      else:  # "text" (default)
          if isinstance(value, TextFormattable):
              print(value.format_text())
          else:
              # Fallback: JSON for types that haven't implemented format_text() yet
              print(json.dumps(_to_json_value(value), sort_keys=True, indent=2))
  ```

### Step 2: Update normalize_output_format()

**File: `src/meridian/cli/output.py`**

- Default (no flag, TTY or not): `"text"`
- `--json`: `"json"`
- `--porcelain`: `"porcelain"`
- `--format text|json|porcelain`: explicit choice
- Remove Rich import and dependency for output (keep if cyclopts needs it internally)

### Step 3: Help text — one-line fix

**File: `src/meridian/cli/main.py`**

```python
app = App(name="meridian", help="Meridian orchestrator CLI", version=__version__, help_formatter="plain")
```

Also set `help_formatter="plain"` on all sub-apps (workspace_app, run_app, etc.).

### Step 4: Add format_text() to all 15 output dataclasses

Each dataclass gets a `format_text(self) -> str` method. Format conventions:
- Lists: one line per item, columns aligned with double-space separator
- Detail views: `key: value` on separate lines, grouped by section
- Action results: single-line summary with key fields
- Omit None/empty fields

#### run.py outputs

**RunActionOutput** (create/continue/retry result):
```
run.create  dry-run  model=gpt-5.3-codex  harness=codex  skills=run-agent,scratchpad
```
Or for completed:
```
run.create  succeeded  r21  model=claude-opus-4-6  5.8s  exit=0
```

**RunListOutput** / **RunListEntry**:
```
r20  failed     gpt-5.3-codex    -    21.6s  -
r19  succeeded  claude-opus-4-6  w15  134.2s  $0.42
```

**RunDetailOutput**:
```
Run: r20
Status: failed (exit 1)
Model: gpt-5.3-codex (codex)
Duration: 21.6s
Workspace: w15
Skills: run-agent, scratchpad
Failure: timeout after 600s
Report: .orchestrate/runs/agent-runs/r20/report.md
```

#### workspace.py outputs

**WorkspaceActionOutput**:
```
Workspace w42 started (fresh session)
```

**WorkspaceListOutput** / **WorkspaceListEntry**:
```
w42  active  my-workspace
w15  paused  research-task
```

**WorkspaceDetailOutput**:
```
Workspace: w42
State: active
Name: my-workspace
Pinned: src/main.py, docs/plan.md
Runs: r20, r19, r18
```

#### Other outputs

**ModelsListOutput**: model table with id, harness, aliases
**SkillsQueryOutput**: skill name + description per line
**ContextActionOutput**: single-line confirmation
**ContextListOutput**: workspace id + file list
**DiagDoctorOutput**: key-value health check
**DiagRepairOutput**: repaired items list
**MigrateRunOutput**: migration summary line

### Step 5: Update tests

- Update `test_cli_output_modes.py` for new format names
- Update `test_cli_smoke.py` assertions that check JSON output without `--json`
- Add tests for `format_text()` on key dataclasses

### Step 6: Clean up

- Remove Rich import from output.py
- Update `--format` help text / error message
- Update `_extract_global_options()` to accept `--format text` (not "plain"/"rich")

## Files Changed

| File | Change |
|------|--------|
| `src/meridian/cli/output.py` | Simplify formats, add TextFormattable, update emit() |
| `src/meridian/cli/main.py` | help_formatter="plain" on all App instances |
| `src/meridian/lib/ops/run.py` | format_text() on RunActionOutput, RunListOutput, RunDetailOutput |
| `src/meridian/lib/ops/workspace.py` | format_text() on WorkspaceActionOutput, WorkspaceListOutput, WorkspaceDetailOutput |
| `src/meridian/lib/ops/models.py` | format_text() on ModelsListOutput |
| `src/meridian/lib/ops/skills.py` | format_text() on SkillsQueryOutput |
| `src/meridian/lib/ops/context.py` | format_text() on ContextActionOutput, ContextListOutput |
| `src/meridian/lib/ops/diag.py` | format_text() on DiagDoctorOutput, DiagRepairOutput |
| `src/meridian/lib/ops/migrate.py` | format_text() on MigrateRunOutput |
| `tests/test_cli_output_modes.py` | Update for new format names |
| `tests/test_cli_smoke.py` | Update assertions |

## Verification

```bash
uv run pytest
uv run pyright
uv run ruff check .
# Manual: uv run meridian list (should show text, not JSON)
# Manual: uv run meridian --json list (should show JSON)
# Manual: uv run meridian -h (should show plain text, no boxes)
```
