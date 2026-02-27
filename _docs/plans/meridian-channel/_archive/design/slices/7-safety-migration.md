# Slice 7: Safety + Cost Guardrails + Migration + Polish

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always)
- [`_docs/plans/meridian-channel/risk-and-gaps.md`](../risk-and-gaps.md) (gap resolution, compatibility contract)
- [`_docs/plans/meridian-channel/cli-contract.md`](../cli-contract.md) (output modes)

**Effort:** 2 days
**Dependencies:** Slice 4 (execution engine), Slice 5b (MCP server), Slice 6 (workspace launcher).
**Model recommendation:** `gpt-5.3-codex`

## Description

Implement permission tiers, cost tracking/budgets, guardrail system, secret redaction, JSONL-to-SQLite migration, skill/agent reference updates, shell completions, and documentation. After this slice, the bash scripts are deprecated. This combines the original Rust plan's Slices 7 and 8.

## Files to create

- `src/meridian/lib/safety/permissions.py` — permission tier model
- `src/meridian/lib/safety/budget.py` — cost budgets
- `src/meridian/lib/safety/guardrails.py` — script-based post-run validation
- `src/meridian/lib/safety/redaction.py` — `--secret` flag redaction

## Permission tiers (fix gap #3)

```python
class PermissionTier(str, Enum):
    READ_ONLY = "read-only"           # Read, Glob, Grep, Bash(git log/status/diff)
    WORKSPACE_WRITE = "workspace-write"  # + Edit, Write, Bash(git add/commit)
    FULL_ACCESS = "full-access"       # + WebFetch, WebSearch, Bash(unrestricted)
    DANGER = "danger"                 # + skip-permissions (requires --unsafe flag)
```

## Cost guardrails

```python
@dataclass
class Budget:
    per_run_usd: float | None = None
    per_workspace_usd: float | None = None
# On breach: SIGTERM to harness, budget_exceeded event, exit code 2
```

## Secret redaction (`--secret`)

Sensitive values passed via `--secret KEY=VALUE` are:
- Available to the harness process via environment variable `MERIDIAN_SECRET_<KEY>`
- Redacted from all logs, reports, and stored artifacts
- Never written to SQLite, JSONL, or markdown files
- Redaction uses a post-processing pass over all output before storage

```python
@dataclass(frozen=True)
class SecretSpec:
    key: str
    value: str  # held in memory only, never persisted

def redact_secrets(text: str, secrets: list[SecretSpec]) -> str:
    """Replace all secret values with [REDACTED:<key>]."""
    for s in secrets:
        text = text.replace(s.value, f"[REDACTED:{s.key}]")
    return text
```

## Migration

1. `meridian migrate` imports existing `runs.jsonl` into SQLite (idempotent)
2. Update all SKILL.md and agent references from `run-agent.sh` -> `meridian run`
3. Rename skill directories: `plan-slicing/` -> `plan-slice/`, `reviewing/` -> `review/`, `researching/` -> `research/`
4. Deprecate bash scripts (keep as fallback)

## Distribution

- `pip install meridian-channel` or `uv tool install meridian-channel`
- Shell completions via cyclopts built-in support
- No cross-compilation needed (pure Python)

## Repo rename (final step)

Rename the repository from `meridian-collab` → `meridian-channel`. This is the last migration step:
1. Update GitHub repo name
2. Update all remote URLs, CI configs, deploy configs
3. Update any references in CLAUDE.md, README, docs
4. Verify all links and imports still resolve

## Acceptance criteria

1. Permission tiers enforced — no dangerous flags without `--unsafe`
2. Per-run budget kills harness on breach
3. Per-workspace budget tracked across runs
4. Guardrail scripts run after each run, failure triggers auto-retry
5. `--secret KEY=VALUE` redacts values from all stored output (logs, reports, artifacts)
6. `meridian migrate` imports existing JSONL data
7. All SKILL.md and agent files reference `meridian`
8. Shell completions generated for bash, zsh, fish
9. `meridian doctor` validates environment
10. Skill directories renamed
