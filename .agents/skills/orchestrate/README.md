# Orchestrate Skill

Automation entrypoints and configuration for plan/slice orchestration.

## Installation

1. Place this `orchestrate/` directory under your skills path (e.g., `.agents/skills/orchestrate/`)
2. Ensure `.claude/skills` symlinks or points to `.agents/skills`
3. Scripts auto-discover `REPO_ROOT` via `git rev-parse`

## `scripts/run-agent.sh` — CLI Wrapper

Single entry point for running any agent. Routes models to the right CLI tool (`claude -p`, `codex exec`), loads skills, composes prompts, and logs each run.

Agent definitions live in `agents/*.md` (markdown with YAML frontmatter).

### Quick Start

```bash
# Using an agent definition
scripts/run-agent.sh review

# Ad-hoc (no agent definition)
scripts/run-agent.sh --model gpt-5.3-codex --skills review -p "Review the changes"

# Agent with model override
scripts/run-agent.sh implement -m claude-opus-4-6

# Dry run
scripts/run-agent.sh review --dry-run

# With template variables
scripts/run-agent.sh implement -v SLICE_FILE=.runs/plans/my-plan/slices/slice-1/slice.md

# Brief report (default: standard)
scripts/run-agent.sh review -D brief
```

### Report Detail (`-D/--detail`)

Every run appends a report instruction to the prompt. The subagent writes `report.md` as its final action. Detail levels:

| Level | Description |
|-------|-------------|
| `brief` | Concise: what was done, pass/fail, blockers |
| `standard` | (default) Decisions, files, verification, issues |
| `detailed` | Thorough: reasoning, all files, full verification, recommendations |

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ORCHESTRATE_RUNS_DIR` | Where to store run data (plans, logs, scratch) | `.runs/` next to skill root |
| `ORCHESTRATE_LOG_DIR` | Override log directory for a single run | Auto-derived from scope |

### Scope Roots

- project scope: `.runs/project/`
- plan scope: `.runs/plans/{plan-name}/`
- phase scope: `.runs/plans/{plan-name}/phases/{phase-name}/`
- slice scope: `.runs/plans/{plan-name}/slices/{slice-name}/` (or via phase)

For any scope root:
- scratch notes: `{scope-root}/scratch/`
- scratch code: `{scope-root}/scratch/code/`
- smoke probes: `{scope-root}/scratch/code/smoke/`
- agent logs/runs: `{scope-root}/logs/agent-runs/`

### Log Artifacts

Each run writes:
- `params.json`
- `input.md`
- `output.json`
- `report.md` (written by the subagent — the orchestrator reads this instead of parsing verbose logs)
- `files-touched.txt` (derived from that run's `output.json`)

The `report.md` is also printed to stdout when the run completes, so the calling process gets the report directly.

If `ORCHESTRATE_LOG_DIR` is not set, `run-agent.sh` auto-derives it from scope variables (`SLICE_FILE`, `SLICES_DIR`, `BREADCRUMBS`, `PLAN_FILE`) and writes to `{scope-root}/logs/agent-runs/` (`TASK_FILE`/`TASKS_DIR` still work as aliases).

## Agent Definitions (`agents/`)

Markdown files with YAML frontmatter. Each file defines model, tools, skills, and prompt for one agent.

Current agents:
- `implement.md` — default implementation (gpt-5.3-codex)
- `implement-iterative.md` — fast UI iteration (claude-sonnet-4-6)
- `implement-deliberate.md` — deep reasoning (claude-opus-4-6)
- `review.md` — code review (gpt-5.3-codex)
- `plan-slice.md` — slice planning (gpt-5.3-codex)
- `cleanup.md` — targeted fixes (gpt-5.3-codex)
- `commit.md` — commit staging (claude-haiku-4-5)

Implementation variant examples:

```bash
# Default exhaustive implementation
scripts/run-agent.sh implement -v SLICE_FILE=.runs/plans/my-plan/slices/slice-1/slice.md

# Fast iterative implementation (good for UI loops)
scripts/run-agent.sh implement-iterative -v SLICE_FILE=.runs/plans/my-plan/slices/slice-1/slice.md

# Deliberate deep-reasoning pass
scripts/run-agent.sh implement-deliberate -v SLICE_FILE=.runs/plans/my-plan/slices/slice-1/slice.md

# Override model on any agent
scripts/run-agent.sh implement -m claude-opus-4-6 -v SLICE_FILE=.runs/plans/my-plan/slices/slice-1/slice.md
```

See the `model-guidance` skill for guidance on when to use each variant.

## `scripts/extract-files-touched.sh`

Parses a single run log and extracts touched file paths:

```bash
scripts/extract-files-touched.sh <output-log> [output-file]
```

## `scripts/save-handoff.sh`

Snapshots `handoffs/latest.md` into a timestamped file:

```bash
scripts/save-handoff.sh .runs/plans/my-plan
```
