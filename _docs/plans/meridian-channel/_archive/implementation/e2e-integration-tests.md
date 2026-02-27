**Status:** draft

# E2E Integration Tests for meridian-channel

## Motivation

The 91 unit tests pass but none verify the full pipeline against real CLI interfaces. The `--skills` bug and model alias bug both shipped because:
1. Adapters were tested against the spec, not against real `--help` output
2. No test ever called `build_command()` and validated the output would be accepted by the real CLI
3. No test verified the pipeline from `-m codex` → `resolve_model()` → `gpt-5.3-codex` → `codex exec --model gpt-5.3-codex`

## Pre-requisite

The FlagStrategy implementation must be merged first (see `flag-strategy-design.md`).

## Test Slices (parallelizable)

All slices use `gpt-5.3-codex` via `/run-agent` with the `scratchpad` skill. Each writes scratch tests to `.scratch/` and committed tests to `meridian-channel/tests/`.

---

### Slice 1: Harness Command Generation (E2E)

**Goal:** Verify `build_command()` output for each adapter matches what the real CLIs accept.

**Tests:**
- For each harness (claude, codex, opencode):
  - Call `build_command()` with typical RunParams
  - Assert `--skills` is NOT in the output
  - Assert `--agent` is only in Claude output
  - Assert prompt placement is correct (flag vs positional)
  - Assert model is the full ID, not an alias
- Claude: verify `--allowedTools` for each permission tier
- Codex: verify `--sandbox` for each permission tier
- Codex: verify `--dangerously-bypass-approvals-and-sandbox` for danger tier
- OpenCode: verify `opencode-gemini` → `--model gemini` (prefix stripped)
- Smoke test: run `claude --help`, `codex exec --help` and assert the flags we generate are in the help output

**Agent command:**
```bash
run-agent.sh --model gpt-5.3-codex --skills scratchpad \
  -f meridian-channel/src/meridian/lib/harness/_strategies.py \
  -f meridian-channel/src/meridian/lib/harness/claude.py \
  -f meridian-channel/src/meridian/lib/harness/codex.py \
  -f meridian-channel/src/meridian/lib/harness/opencode.py \
  -f meridian-channel/src/meridian/lib/safety/permissions.py \
  -p "Write E2E tests for harness command generation..."
```

---

### Slice 2: Model Alias Resolution Pipeline

**Goal:** Verify aliases resolve to full model IDs through the entire run pipeline.

**Tests:**
- `resolve_model("codex")` → `gpt-5.3-codex`
- `resolve_model("opus")` → `claude-opus-4-6`
- `resolve_model("sonnet")` → `claude-sonnet-4-6`
- `resolve_model("haiku")` → `claude-haiku-4-5`
- `resolve_model("gemini")` → `gemini-3.1-pro`
- `resolve_model("gpt52h")` → `gpt-5.2-high`
- `resolve_model("unknown-thing")` → KeyError
- `resolve_run_defaults("codex", ...)` → defaults.model == `gpt-5.3-codex` (not `codex`)
- Full pipeline: `_build_create_payload()` with `-m codex` → RunParams.model == `gpt-5.3-codex`
- Custom model override via `.meridian/models.toml` — add a custom model, verify it resolves
- Ambiguous alias → ValueError

**Agent command:**
```bash
run-agent.sh --model gpt-5.3-codex --skills scratchpad \
  -f meridian-channel/src/meridian/lib/config/catalog.py \
  -f meridian-channel/src/meridian/lib/prompt/assembly.py \
  -f meridian-channel/src/meridian/lib/ops/run.py \
  -p "Write E2E tests for model alias resolution..."
```

---

### Slice 3: Permission Flag Generation (E2E)

**Goal:** Verify permission flags are correct for each harness × tier combination.

**Tests:**
- Matrix test: 3 harnesses × 4 tiers = 12 combinations
- Each combination: call `permission_flags_for_harness()` and verify output
- Verify danger tier without `--unsafe` raises ValueError
- Verify Claude `--allowedTools` lists are monotonically expanding (read-only ⊂ workspace-write ⊂ full-access)
- Smoke test: parse `claude --help` output and verify `--allowedTools` and `--dangerously-skip-permissions` are real flags
- Smoke test: parse `codex exec --help` output and verify `--sandbox` values match

**Agent command:**
```bash
run-agent.sh --model gpt-5.3-codex --skills scratchpad \
  -f meridian-channel/src/meridian/lib/safety/permissions.py \
  -p "Write E2E tests for permission flag generation..."
```

---

### Slice 4: Prompt Composition Pipeline

**Goal:** Verify the full prompt composition pipeline produces correct output.

**Tests:**
- Skills are composed into prompt text (not as CLI flags)
- Agent body is composed into prompt text
- Model guidance is included
- Template variables are substituted
- Report instruction is appended
- Reference files are included
- Prompt does NOT contain raw `--skills` or `--agent` flag syntax
- Sanitization: closing boundary markers are escaped

**Agent command:**
```bash
run-agent.sh --model gpt-5.3-codex --skills scratchpad \
  -f meridian-channel/src/meridian/lib/prompt/compose.py \
  -f meridian-channel/src/meridian/lib/prompt/assembly.py \
  -f meridian-channel/src/meridian/lib/prompt/sanitize.py \
  -f meridian-channel/src/meridian/lib/prompt/reference.py \
  -p "Write E2E tests for prompt composition..."
```

---

### Slice 5: Dry-Run Full Pipeline

**Goal:** Verify `meridian run create --dry-run` produces valid commands for each harness.

**Tests:**
- `uv run meridian run create -p "test" -m codex --dry-run --json` → verify:
  - `cli_command` contains `codex exec`
  - `cli_command` contains `--model gpt-5.3-codex` (resolved alias)
  - `cli_command` does NOT contain `--skills`
  - `composed_prompt` contains skill content
- Same for `-m opus` → verify `claude -p` with `--model claude-opus-4-6`
- Same for `-m sonnet` → verify claude harness
- Same for `-m haiku` → verify claude harness
- With `--agent coder` → verify `--agent coder` only for claude harness
- With `--permission workspace-write` → verify correct flags per harness
- These are actual subprocess calls to the meridian CLI (true E2E)

**Agent command:**
```bash
run-agent.sh --model gpt-5.3-codex --skills scratchpad \
  -f meridian-channel/src/meridian/cli/run.py \
  -f meridian-channel/src/meridian/lib/ops/run.py \
  -p "Write E2E tests using subprocess calls to 'uv run meridian run create --dry-run --json'..."
```

---

### Slice 6: MCP Tool Dry-Run

**Goal:** Verify MCP server exposes correct tool schemas and dry-run works via MCP.

**Tests:**
- Start MCP server, list tools, verify `run_create` exists with correct params
- Call `run_create` with dry_run=true via MCP protocol
- Verify returned `cli_command` is correct (same validations as Slice 5)
- Verify non-blocking behavior (MCP returns immediately with status "running")

**Agent command:**
```bash
run-agent.sh --model gpt-5.3-codex --skills scratchpad \
  -f meridian-channel/src/meridian/server/main.py \
  -p "Write E2E tests for MCP server tool exposure and dry-run..."
```

---

## Execution Plan

```
Phase 1 (parallel): Slices 1, 2, 3, 4  — unit-level E2E (no subprocess)
Phase 2 (parallel): Slices 5, 6         — subprocess E2E (actual CLI + MCP)
```

Phase 2 depends on Phase 1 passing (the fixes must be correct before testing the full pipeline).

## Agent Profile Fix

Before execution, add `scratchpad` skill to agent profiles:

```yaml
# coder.md
skills: [scratchpad]

# reviewer.md
skills: [reviewing, scratchpad]
```

## Success Criteria

- All new tests pass: `uv run pytest meridian-channel/tests/`
- pyright clean: `uv run pyright`
- ruff clean: `uv run ruff check .`
- Dry-run commands validated against real CLI `--help` output
- No `--skills` flag in any generated command
- No unresolved model aliases in any generated command
