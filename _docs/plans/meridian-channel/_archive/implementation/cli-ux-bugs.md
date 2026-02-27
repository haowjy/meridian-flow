**Status:** approved

# CLI UX Bugs & Design Fixes

## Bugs

### Bug 1: `meridian start` exits immediately (workspace never interactive)

**Reproduction:**
```bash
uv run meridian start
# Returns instantly with state "paused", exit_code 0
```

**Root cause:** `launch.py:103-123` builds the workspace supervisor command using `ClaudeAdapter.build_command()`. ClaudeAdapter has `BASE_COMMAND = ("claude", "-p")` and `PROMPT_MODE = FLAG`, so the command becomes:

```
claude -p "<prompt>" --model claude-opus-4-6
```

`claude -p` is one-shot mode — Claude processes the prompt, outputs a response, and exits. For an interactive workspace session, the command should be `claude` without `-p` (interactive mode), with the prompt injected as a system prompt or via `--system-prompt` / resume flags.

**Impact:** Workspaces are completely broken. The entire workspace feature (start, resume, pin context) is unusable.

**Fix direction:** Workspace launch needs a separate command builder that doesn't go through the harness adapter's `build_command()`. The workspace supervisor is inherently interactive (takes over the terminal), while `build_command()` is designed for one-shot runs. Options:
- Use `claude --system-prompt <prompt>` for fresh sessions
- Use `claude --resume` for continuation sessions
- Use `os.execvp()` instead of `subprocess.Popen` to fully replace the process (the current Popen approach captures output, but workspace needs the terminal)

### Bug 2: Rich box help formatting wastes tokens

**Reproduction:**
```bash
uv run meridian -h
# Output:
# ╭─ Commands ──────────────────╮
# │ completion   Shell...       │
# ╰─────────────────────────────╯
```

**Root cause:** Cyclopts uses Rich for help rendering by default. Our `--format` flag only affects command output (via `emit()`), not help text. There's no way to tell Cyclopts to use plain formatting. Smoke test confirmed: `NO_COLOR=1` does NOT suppress the box-drawing characters.

**Impact:** When agents consume `meridian --help`, the box-drawing characters waste tokens and provide no value.

**Fix direction:** Cyclopts supports a `help_format` parameter or custom help handler. Options:
- Set `App(help_format="plaintext")` or equivalent cyclopts config
- Create a custom help formatter that outputs plain text
- Respect `--format` for help output too (if `--format plain` is set, suppress Rich)
- Auto-detect: if `NO_COLOR` env var is set or not a TTY, use plain help

### Bug 3: `--no-json` flag crashes

**Reproduction:**
```bash
uv run meridian list --no-json
# Error: Unknown option: "--no-json"
uv run meridian list --no-porcelain
# Error: Unknown option: "--no-porcelain"
```

**Root cause:** Global options are manually parsed in `_extract_global_options()` (main.py:55-102). This parser only handles `--json`, `--porcelain`, `--format`, `--yes`, `--no-input`. Cyclopts auto-generates `--no-json` / `--no-porcelain` / `--no-yes` in the help text (because they're bool flags), but the manual parser doesn't strip them. They pass through to cyclopts' subcommand parser which rejects them.

**Impact:** Minor — but confusing since the help text shows `--no-json` as valid.

**Fix direction:** Either:
- Add `--no-json`, `--no-porcelain`, `--no-yes`, `--no-no-input` to the manual parser
- Or switch from manual arg extraction to cyclopts' built-in middleware/meta approach for global options
- Or suppress the `--no-*` variants from cyclopts help output

### Bug 4: Default output is always JSON (no LLM/human-friendly view)

**Reproduction:**
```bash
uv run meridian list
# Output (on TTY):
# {
#   "runs": [
#     {"run_id": "r20", "status": "failed", ...}
#   ]
# }
```

**Root cause:** `_emit_rich()` calls `console.print_json()` which is just colorized JSON. There is no table/human-readable formatter for any command. All four output modes (rich, plain, json, porcelain) produce variations of JSON. Smoke test confirmed: `default`, `--format plain`, `--format rich`, and `--format text` all emit the same pretty-printed JSON.

**Impact:** The CLI always looks like a machine-readable API, not a user-facing tool. Meridian is an agent-first tool — the default output should be **LLM-readable** (concise, structured text), not JSON blobs.

**Fix direction:** Rethink the output format hierarchy:
1. **Default (no flag):** LLM-readable text — concise, scannable, minimal tokens. This is the primary consumer.
2. **`--json`:** Machine-parseable JSON for programmatic use.
3. **`--porcelain`:** Tab-separated for shell scripting.
4. **`--rich`:** Pretty tables with color for human TTY sessions (opt-in).

Example desired default output for `meridian list`:
```
r20  failed   gpt-5.3-codex  -    21.6s  -
r19  done     claude-opus    w15  134.2s  $0.42
```

Example desired default output for `meridian run -p "hi"`:
```
Run r21 completed (5.8s, claude-opus-4-6, exit 0)
```

### Bug 5: Prompt is Template repr, not rendered text (CRITICAL)

**Reproduction:**
```bash
uv run meridian run -p "hi"
# cli_command contains:
# "Template(strings=('', '\n\n', '\n\n', '\n'), interpolations=(Interpolation('# Skill: run-agent\n...'..."
```

**Root cause:** `compose_run_prompt_text()` in `compose.py:140` does:
```python
return str(template).strip()
```

But Python 3.14's `str(Template)` returns the **repr** of the Template object, not the rendered text. `str(Template(...))` → `"Template(strings=(...), interpolations=(...))"`

**Impact:** **CRITICAL** — Every single prompt sent to every harness is the raw Template repr, not actual prompt text. Every run gets garbage. Smoke test confirmed: all 7 model alias dry-runs, all basic commands — every single one has `Template(strings=` in the prompt.

**Fix direction:** Replace `str(template)` with proper Template rendering:
```python
def _render_template(template: Template) -> str:
    """Render a PEP 750 t-string Template to plain text."""
    parts: list[str] = []
    for i, s in enumerate(template.strings):
        parts.append(s)
        if i < len(template.interpolations):
            parts.append(str(template.interpolations[i].value))
    return "".join(parts)
```

### Bug 6: Gemini model routes to wrong harness

**Reproduction:**
```bash
uv run meridian run -p 'test' -m gemini --dry-run --json
# model resolves to "gemini-3.1-pro" (correct)
# harness_id is "codex" (WRONG — should be "opencode")
# Warning: "Unknown model family 'gemini-3.1-pro'. Falling back to codex"
```

**Root cause:** Model alias resolution in `assembly.py` resolves `gemini` → `gemini-3.1-pro`, but then the model routing in `routing.py` doesn't recognize `gemini-3.1-pro` as an opencode model. The routing rules match `opencode-*` and `provider/model` patterns, but `gemini-3.1-pro` matches neither — it falls through to the codex default.

The catalog entry for gemini has `harness = "opencode"`, but `route_model()` uses pattern-matching on the model ID string, not catalog metadata.

**Impact:** Gemini runs route to the wrong CLI entirely.

**Fix direction:** `route_model()` should check catalog `harness` field as a fallback when pattern-matching fails, or the gemini pattern should be added to the routing rules.

### Bug 7: Unknown model accepted silently in dry-run

**Reproduction:**
```bash
uv run meridian run -p 'test' -m nonexistent-model --dry-run --json
# exit 0, warning message, but no error
# model field: "nonexistent-model" (unresolved)
# cli_command: --model nonexistent-model
```

**Impact:** Low — dry-run should probably warn but not fail. However, the warning says "falling back to codex" while the `cli_command` still uses `--model nonexistent-model`, which is inconsistent (Bug 8).

### Bug 8: Fallback warning inconsistent with actual command

**Reproduction:**
```bash
uv run meridian run -p 'test' -m nonexistent-model --dry-run --json
# warning: "Unknown model family 'nonexistent-model'. Falling back to codex (gpt-5.3-codex)."
# cli_command: ["codex", "exec", "--model", "nonexistent-model", ...]
```

**Root cause:** The warning says fallback to `gpt-5.3-codex` but the `--model` flag still uses the original unresolved model string. The routing picks the harness (codex) but doesn't replace the model ID.

**Impact:** Medium — if the run actually executes, codex would receive `--model nonexistent-model` and fail.

### Bug 9: Unknown skill crashes with Python traceback

**Reproduction:**
```bash
uv run meridian run -p 'test' --skills nonexistent-skill --dry-run --json
# Python traceback: KeyError: 'Unknown skills: nonexistent-skill'
```

**Root cause:** `run.py` raises `KeyError` for unknown explicit skills, but this isn't caught and formatted as a structured CLI error.

**Impact:** Medium — user sees a raw Python traceback instead of a clean error message.

**Fix direction:** Catch `KeyError` in the CLI layer and emit a structured error response.

### Bug 10: Empty prompt accepted

**Reproduction:**
```bash
uv run meridian run -p '' --dry-run --json
# exit 0, produces a dry-run payload with empty user prompt
```

**Impact:** Low — empty prompts are meaningless but not harmful in dry-run. Could add validation.

### Bug 11: `workspace start --dry-run` not supported

**Reproduction:**
```bash
uv run meridian workspace start --dry-run
# Error: Unknown option: "--dry-run"
```

**Impact:** Low — no way to preview workspace commands without launching. Would be useful for debugging.

### Bug 12: Doctor path inconsistency

**Reproduction:**
```bash
# From meridian-channel/ (submodule):
uv run meridian doctor     # Reports .agents/ missing (ok: false)
uv run meridian skills list  # Finds skills from parent repo .agents/
```

**Root cause:** `doctor` checks for `.agents/` relative to the working directory, while `skills list` resolves the repo root up the directory tree and finds `.agents/` in the parent repo.

**Impact:** Low — confusing but not blocking.

## Priority

| Bug | Severity | Effort | Slice |
|-----|----------|--------|-------|
| 5 - Template repr in prompts | **CRITICAL** — all prompts are garbage | Low | A |
| 6 - Gemini routes to wrong harness | **High** — wrong CLI for gemini | Low | A |
| 8 - Fallback warning inconsistent | **Medium** — misleading output | Low | A |
| 9 - Unknown skill traceback | **Medium** — raw traceback to user | Low | A |
| 3 - `--no-json` crash | **Low** — easy fix | Low | A |
| 1 - Workspace broken | **Critical** — feature unusable | Medium | B |
| 4 - No LLM-friendly output | **High** — bad DX for all commands | Medium | C |
| 2 - Rich help boxes | **Medium** — token waste | Low | C |
| 7 - Unknown model accepted | **Low** — minor inconsistency | Low | D |
| 10 - Empty prompt accepted | **Low** — no harm | Low | D |
| 11 - No workspace dry-run | **Low** — missing feature | Low | D |
| 12 - Doctor path inconsistency | **Low** — confusing | Low | D |

## Implementation Slices

### Slice A: Critical fixes (Bugs 5, 6, 8, 9, 3) — parallelizable

All low-effort, high-impact fixes that can be done in one agent run.

**Bug 5 fix:** Replace `str(template)` with proper Template rendering in `compose.py:140`:
```python
def _render_template(template: Template) -> str:
    parts: list[str] = []
    for i, s in enumerate(template.strings):
        parts.append(s)
        if i < len(template.interpolations):
            parts.append(str(template.interpolations[i].value))
    return "".join(parts)
```

**Bug 6 fix:** In `routing.py`, add `gemini` pattern to the routing rules, or fall back to catalog `harness` field when pattern-matching fails.

**Bug 8 fix:** When routing falls back to a default harness, either (a) replace the model ID with the fallback model, or (b) don't claim to fall back — just warn about unknown family.

**Bug 9 fix:** Catch `KeyError` for unknown skills in the CLI handler and emit a structured error.

**Bug 3 fix:** Add `--no-json`, `--no-porcelain`, `--no-yes`, `--no-no-input` to `_extract_global_options()`.

**Files:** `compose.py`, `routing.py`, `run.py`, `main.py`
**Tests:** Add regression tests for each fix.
**Verify:** `uv run pytest`, `uv run pyright`, `uv run ruff check .`

### Slice B: Workspace launch fix (Bug 1)

Separate workspace launch from the one-shot harness `build_command()` path.

**Approach:**
1. New `build_interactive_supervisor_command()` in `launch.py` that produces `["claude", "--system-prompt", "<prompt>", "--model", "<model>"]`
2. Replace `subprocess.Popen` + `wait()` with `os.execvp()` — meridian replaces itself with claude for seamless terminal handoff
3. Write workspace state to lock file before exec; detect orphaned locks on next invocation
4. Add `--dry-run` support to `workspace start` (Bug 11)

**Files:** `launch.py`, `workspace.py` (CLI), `workspace.py` (ops)
**Tests:** Unit test for command builder; integration test for dry-run
**Verify:** `uv run pytest`, `uv run pyright`, `uv run ruff check .`

### Slice C: Output formatting overhaul (Bugs 4, 2)

Rethink the default output format for an agent-first CLI.

**Approach:**
1. Change default format from "rich"/"plain" JSON to LLM-readable concise text
2. Each operation output dataclass gets a `format_text()` classmethod that renders concise output
3. `emit()` calls `format_text()` for default mode, `json.dumps()` for `--json`
4. Research cyclopts `help_format` API to suppress Rich boxes in help output (Bug 2)
5. If cyclopts doesn't support it, write a custom help handler

**Files:** `output.py`, each ops module output dataclass, `main.py` (App config)
**Tests:** Update `test_cli_output_modes.py` for new default format
**Verify:** `uv run pytest`, `uv run pyright`, `uv run ruff check .`

### Slice D: Low-priority polish (Bugs 7, 10, 11, 12) — defer

These are minor inconsistencies that don't block usage. Can be fixed opportunistically.

## Smoke Test Evidence

All bugs confirmed by 5 parallel smoke test agents. Evidence in:
- `.scratch/smoke-basic-run.md` — Bug 5, Bug 4 confirmed
- `.scratch/smoke-model-aliases.md` — Bugs 5, 6, 7, 8 confirmed across all 7 model aliases
- `.scratch/smoke-workspace.md` — Bugs 1, 4, 2, 11 confirmed
- `.scratch/smoke-formatting.md` — Bugs 2, 3, 4 confirmed; NO_COLOR ineffective
- `.scratch/smoke-edge-cases.md` — Bugs 5, 9, 10, 12 confirmed
