**Status:** approved

# Flag Strategy Pattern — Harness Adapter Redesign

## Problem

All three harness adapters (Claude, Codex, OpenCode) have copy-pasted `build_command` logic that blindly passes `--skills` and `--agent` to downstream CLIs. None of these CLIs support `--skills`, and only Claude supports `--agent`. This causes hard failures (codex rejects unknown flags).

Additionally, model aliases (e.g. `codex` → `gpt-5.3-codex`) are never resolved before reaching the harness — `resolve_model()` exists but isn't called in the run pipeline.

## Current State

```python
# All three adapters do this (wrong):
def build_command(self, run: RunParams, perms: PermissionResolver) -> list[str]:
    command = ["claude", "-p", run.prompt, "--model", str(run.model)]
    if run.agent:
        command.extend(["--agent", run.agent])      # only claude supports this
    if run.skills:
        command.extend(["--skills", ",".join(run.skills)])  # NO CLI supports this
    command.extend(perms.resolve_flags(self.id))
    command.extend(run.extra_args)
    return command
```

## Real CLI Flag Support

| Meridian concept | Claude CLI | Codex CLI | OpenCode CLI |
|---|---|---|---|
| prompt | `-p <text>` | positional | positional |
| model | `--model <m>` | `--model <m>` | `--model <m>` |
| skills | N/A (baked into prompt) | N/A (baked into prompt) | N/A (baked into prompt) |
| agent | `--agent <name>` | N/A | N/A |
| perm: read-only | `--allowedTools Read,Glob,...` | `--sandbox read-only` | (none) |
| perm: workspace-write | `--allowedTools ...+Edit,Write` | `--sandbox workspace-write` | (none) |
| perm: full-access | `--allowedTools ...+Bash,Web*` | `--sandbox danger-full-access` | (none) |
| perm: danger | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | (none) |
| budget | `--max-budget-usd <n>` | (none) | (none) |
| output format | `--output-format stream-json` | `--json` | ??? |
| session resume | `--resume <id>` | `exec resume` subcommand | ??? |
| working dir | (cwd) | `-C <dir>` | ??? |

## Design: FlagStrategy Pattern

### Core Types

```python
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Callable, Literal

class FlagEffect(StrEnum):
    """What a strategy does with a RunParams field."""
    CLI_FLAG = "cli_flag"       # Emit as a CLI flag (pass-through or renamed)
    TRANSFORM = "transform"     # Custom transformation (modify command args)
    DROP = "drop"               # Field already handled elsewhere; do nothing

@dataclass(frozen=True)
class FlagStrategy:
    """Declares how one RunParams field maps to harness CLI args."""
    effect: FlagEffect
    cli_flag: str | None = None
    transform: Callable[[object, list[str]], None] | None = None  # for TRANSFORM

StrategyMap = dict[str, FlagStrategy]
```

### Prompt Placement

Each adapter declares how the prompt is placed in the command:

```python
class PromptMode(StrEnum):
    FLAG = "flag"               # -p <prompt> (Claude)
    POSITIONAL = "positional"   # <prompt> as last positional arg (Codex, OpenCode)
```

### Strategy Maps (per harness)

```python
def _opencode_model_transform(value: object, args: list[str]) -> None:
    """Strip opencode- prefix before passing to CLI."""
    model = str(value)
    if model.startswith("opencode-"):
        model = model[len("opencode-"):]
    args.extend(["--model", model])

CLAUDE_STRATEGIES: StrategyMap = {
    "model":  FlagStrategy(FlagEffect.CLI_FLAG, cli_flag="--model"),
    "agent":  FlagStrategy(FlagEffect.CLI_FLAG, cli_flag="--agent"),
    "skills": FlagStrategy(FlagEffect.DROP),
}

CODEX_STRATEGIES: StrategyMap = {
    "model":  FlagStrategy(FlagEffect.CLI_FLAG, cli_flag="--model"),
    "agent":  FlagStrategy(FlagEffect.DROP),   # already composed into prompt
    "skills": FlagStrategy(FlagEffect.DROP),
}

OPENCODE_STRATEGIES: StrategyMap = {
    "model":  FlagStrategy(FlagEffect.TRANSFORM, transform=_opencode_model_transform),
    "agent":  FlagStrategy(FlagEffect.DROP),   # already composed into prompt
    "skills": FlagStrategy(FlagEffect.DROP),
}
```

Key decisions from review:
- **`agent` is DROP for Codex/OpenCode** — the agent body is already composed into the prompt by `compose_run_prompt_text()`. Injecting `[Agent: name]` via prompt_prepend would duplicate it.
- **OpenCode model is TRANSFORM** — preserves the existing `_strip_opencode_prefix()` behavior.
- **No `CommandParts` accumulator** — the TRANSFORM callback appends directly to a `list[str]` args buffer. Simpler, no dead `env` field.

### Shared Build Logic

```python
def build_harness_command(
    *,
    base_command: list[str],
    prompt_mode: PromptMode,
    run: RunParams,
    strategies: StrategyMap,
    perms: PermissionResolver,
    harness_id: HarnessId,
) -> list[str]:
    """Generic command builder driven by strategy maps."""
    strategy_args: list[str] = []

    for field_name, strategy in strategies.items():
        value = getattr(run, field_name, None)
        if value is None:                          # explicit None check, not falsy
            continue

        match strategy.effect:
            case FlagEffect.CLI_FLAG:
                assert strategy.cli_flag is not None
                if isinstance(value, tuple):
                    if value:  # skip empty tuples
                        strategy_args.extend([strategy.cli_flag, ",".join(value)])
                else:
                    strategy_args.extend([strategy.cli_flag, str(value)])

            case FlagEffect.TRANSFORM:
                assert strategy.transform is not None
                strategy.transform(value, strategy_args)

            case FlagEffect.DROP:
                pass

    # Assemble command with correct prompt placement
    command = list(base_command)
    command.extend(strategy_args)
    command.extend(perms.resolve_flags(harness_id))

    match prompt_mode:
        case PromptMode.FLAG:
            # Claude: -p <prompt> is already in base_command prefix
            command.append(run.prompt)
        case PromptMode.POSITIONAL:
            # Codex/OpenCode: prompt is last positional arg
            command.append(run.prompt)

    command.extend(run.extra_args)
    return command
```

Note: For Claude, `base_command = ["claude", "-p"]` and prompt is appended right after. For Codex/OpenCode, `base_command = ["codex", "exec"]` / `["opencode", "run"]` and prompt goes at the end after all flags. The `prompt_mode` determines ordering:
- `FLAG`: `claude -p <prompt> --model X --agent Y ...perms ...extra`
- `POSITIONAL`: `codex exec --model X ...perms <prompt> ...extra`

Wait — looking at the real CLIs more carefully:
- Claude: `claude -p <prompt> --model <m>` (prompt can be anywhere, it's a named flag)
- Codex: `codex exec [OPTIONS] [PROMPT]` (prompt is a positional, options go before)
- OpenCode: `opencode run --model <m> [PROMPT]` (same as codex)

So the correct assembly is:
- **FLAG mode**: `[base] + [strategy_args] + [perms] + [prompt] + [extra]` — but prompt is via `-p` flag so order doesn't matter. Simplify to: `["claude", "-p", prompt] + strategy_args + perms + extra`
- **POSITIONAL mode**: `[base] + [strategy_args] + [perms] + [prompt] + [extra]` — prompt must come after all options.

Updated assembly:

```python
match prompt_mode:
    case PromptMode.FLAG:
        command = [*base_command, run.prompt, *strategy_args]
    case PromptMode.POSITIONAL:
        command = [*base_command, *strategy_args]
        command.extend(perms.resolve_flags(harness_id))
        command.append(run.prompt)
        command.extend(run.extra_args)
        return command

# FLAG mode: perms and extra after prompt
command.extend(perms.resolve_flags(harness_id))
command.extend(run.extra_args)
return command
```

### Simplified Adapters

Each adapter becomes a thin declaration:

```python
class ClaudeAdapter:
    STRATEGIES = CLAUDE_STRATEGIES
    PROMPT_MODE = PromptMode.FLAG
    BASE_COMMAND = ["claude", "-p"]

    def build_command(self, run: RunParams, perms: PermissionResolver) -> list[str]:
        return build_harness_command(
            base_command=self.BASE_COMMAND,
            prompt_mode=self.PROMPT_MODE,
            run=run,
            strategies=self.STRATEGIES,
            perms=perms,
            harness_id=self.id,
        )

class CodexAdapter:
    STRATEGIES = CODEX_STRATEGIES
    PROMPT_MODE = PromptMode.POSITIONAL
    BASE_COMMAND = ["codex", "exec"]

    def build_command(self, run: RunParams, perms: PermissionResolver) -> list[str]:
        return build_harness_command(
            base_command=self.BASE_COMMAND,
            prompt_mode=self.PROMPT_MODE,
            run=run,
            strategies=self.STRATEGIES,
            perms=perms,
            harness_id=self.id,
        )

class OpenCodeAdapter:
    STRATEGIES = OPENCODE_STRATEGIES
    PROMPT_MODE = PromptMode.POSITIONAL
    BASE_COMMAND = ["opencode", "run"]

    def build_command(self, run: RunParams, perms: PermissionResolver) -> list[str]:
        return build_harness_command(
            base_command=self.BASE_COMMAND,
            prompt_mode=self.PROMPT_MODE,
            run=run,
            strategies=self.STRATEGIES,
            perms=perms,
            harness_id=self.id,
        )
```

## Fix 2: Model Alias Resolution in Run Pipeline

`resolve_run_defaults()` in `prompt/assembly.py` passes the raw model string through without resolving aliases. Add alias resolution:

```python
# In resolve_run_defaults(), after line 76:
resolved_model = default_model

# ADD: resolve alias to full model ID
try:
    from meridian.lib.config.catalog import resolve_model
    catalog_entry = resolve_model(resolved_model)
    resolved_model = str(catalog_entry.model_id)
except (KeyError, ValueError):
    pass  # unknown model, pass through as-is for harness to handle
```

This ensures `codex` → `gpt-5.3-codex`, `opus` → `claude-opus-4-6`, etc. before the model reaches the harness adapter. Unknown models pass through unchanged (the harness router already warns on unknown patterns).

## What About Permissions?

Permissions are **already correctly adapted** via `PermissionResolver.resolve_flags(harness_id)`. This pattern works well and doesn't need to change. The FlagStrategy pattern handles the RunParams fields that permissions don't cover (skills, agent, model, etc.).

## Completeness Guard

Add a test that asserts every `RunParams` field (except `prompt` and `extra_args`) has an explicit entry in each harness strategy map. This prevents silent omissions when new fields are added:

```python
def test_all_run_params_fields_mapped():
    """Every RunParams field must be explicitly handled by each harness."""
    import dataclasses
    from meridian.lib.harness.adapter import RunParams

    skip = {"prompt", "extra_args"}  # handled separately
    param_fields = {f.name for f in dataclasses.fields(RunParams)} - skip

    for adapter_cls in [ClaudeAdapter, CodexAdapter, OpenCodeAdapter]:
        mapped = set(adapter_cls.STRATEGIES.keys())
        missing = param_fields - mapped
        assert not missing, f"{adapter_cls.__name__} missing strategies for: {missing}"
```

## Migration Steps

1. Add `FlagEffect`, `FlagStrategy`, `PromptMode`, `build_harness_command` to new `harness/_strategies.py`
2. Define strategy maps as class attributes on each adapter
3. Rewrite each adapter's `build_command` to delegate to `build_harness_command`
4. Wire `resolve_model()` into `resolve_run_defaults()` in `prompt/assembly.py`
5. Add completeness guard test
6. Update existing tests: verify skills NOT passed as CLI flags, agent only on Claude, model aliases resolved
7. Run full test suite: `uv run pytest && uv run pyright && uv run ruff check .`
