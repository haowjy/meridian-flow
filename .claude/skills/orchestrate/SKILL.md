---
name: orchestrate
description: Run the plan-slice pipeline using CLI subagents with model routing. Codex for plan/implement, Claude opus for review/cleanup, Claude haiku for commit.
allowed-tools: Bash(codex *), Bash(CLAUDECODE=* claude *), Bash(git *), Bash(cat *), Bash(mktemp *), Bash(rm *), Read, Edit, Write, Glob, Grep
---

# Orchestrate

Run an automated plan-slice pipeline using CLI subagents with cross-model routing.

## Usage

```
/orchestrate <plan-file> [--max-slices N] [--start-at stage]
```

- `plan-file` — path to the plan markdown file (required)
- `--max-slices N` — cap total slice iterations (default: 20)
- `--start-at stage` — resume from a specific stage: `plan|implement|review|cleanup|commit`

## Stage Configuration

| Stage | CLI Tool | Model | Skill Instructions | Max Turns |
|-------|----------|-------|--------------------|-----------|
| plan-slice | `codex exec` | `gpt5.3-codex-high` | `.claude/skills/plan-slice/SKILL.md` | — |
| implement | `codex exec` | `gpt5.3-codex-high` | CLAUDE.md (auto-discovered) | — |
| review | `claude -p` | `opus` | `.claude/skills/review/SKILL.md` + `rules/*.md` | 15 |
| cleanup | `claude -p` | `opus` | Stack-relevant `rules/*.md` | 10 |
| commit | `claude -p` | `haiku` | None | 5 |

## Pipeline

Each slice iterates 5 stages. Communication happens via task files in `_docs/hidden/tasks/`.

**Before starting:** Create `_docs/hidden/tasks/` directory if it doesn't exist.

### How to Execute Each Stage

For every stage, follow this exact process:

1. **Read the prompt template** from `scripts/orchestrator/prompts/{stage}.md`
2. **Read skill instructions** for that stage (SKILL.md + rule files per table above)
3. **Read outputs from previous stage** (task files via `_docs/hidden/tasks/`, `git diff --stat`)
4. **Compose a prompt** by combining: template + skill instructions + a `## Parent Context` section containing your observations, decisions, and relevant context from prior stages
5. **Write the composed prompt** to a temp file: `mktemp /tmp/orchestrate-{stage}-XXXXXX.md`
6. **Launch the CLI subprocess** via Bash using the correct invocation pattern (see below)
7. **Read results** — check task files and git state, evaluate outcome, decide whether to continue

### CLI Invocation Patterns

**Codex** (plan-slice, implement):
```bash
codex exec -m gpt5.3-codex-high --full-auto --json - < /tmp/prompt-file.md
```
- Auto-discovers CLAUDE.md/AGENTS.md for project context
- Reads prompt from stdin via `-`

**Claude** (review, cleanup, commit):
```bash
CLAUDECODE= claude -p - --model opus --output-format json \
  --max-turns 15 --allowedTools "Read,Edit,Write,Bash,Glob,Grep" \
  --dangerously-skip-permissions < /tmp/prompt-file.md
```
- `CLAUDECODE=` unsets nested session check
- Adjust `--model` per stage table (`opus` or `haiku`)
- Adjust `--max-turns` per stage table
- Commit stage: use `--allowedTools "Bash,Read,Glob,Grep"` (no Edit/Write)

### Stage 1: Plan Slice

**Prompt composition:**
1. Read `scripts/orchestrator/prompts/plan-slice.md`
2. Read `.claude/skills/plan-slice/SKILL.md` for slice-creation instructions
3. Replace `{{PLAN_FILE}}` with the actual plan path
4. Replace `{{TASKS_DIR}}` with `_docs/hidden/tasks`
5. Add `## Parent Context` with: which slices are done, any observations from prior iterations, guidance on slice scope

**Launch:** `codex exec -m gpt5.3-codex-high --full-auto --json - < {temp_file}`

**After return:** Read `_docs/hidden/tasks/current.md`. If it contains only `ALL_DONE`, stop the pipeline and tell the user the plan is fully implemented.

**Quality gate:** If the slice is too large (>5 files), unclear criteria, or doesn't reference plan phases — add feedback to `## Parent Context` and re-run once. If still bad, flag to user.

### Stage 2: Implement

**Prompt composition:**
1. Read `scripts/orchestrator/prompts/implement.md`
2. Replace `{{TASKS_DIR}}` with `_docs/hidden/tasks`
3. Add `## Parent Context` with: summary of the slice, any architectural notes, relevant patterns from earlier slices

**Launch:** `codex exec -m gpt5.3-codex-high --full-auto --json - < {temp_file}`

**After return:** Run `git diff --stat` to see what changed. Read `_docs/hidden/tasks/current.md` to check for `## Completed` section. If acceptance criteria appear unmet, flag to user before continuing.

### Stage 3: Review

**Prompt composition:**
1. Read `scripts/orchestrator/prompts/review.md`
2. Read `.claude/skills/review/SKILL.md` for the full review process
3. Read all relevant rule files from `.claude/skills/review/rules/`:
   - Always include `general.md`
   - If `backend/` files changed → include `backend.md`
   - If `frontend/` files changed → include `frontend.md`
4. Replace `{{TASKS_DIR}}` with `_docs/hidden/tasks`
5. Embed the rule file contents directly in the composed prompt under `## Review Rules`
6. Add `## Parent Context` with: what was implemented, which files changed, any areas of concern

**Launch:** `CLAUDECODE= claude -p - --model opus --output-format json --max-turns 15 --allowedTools "Read,Edit,Write,Bash,Glob,Grep" --dangerously-skip-permissions < {temp_file}`

**After return:** Check for `_docs/hidden/tasks/cleanup-*.md` files.

### Stage 4: Cleanup

**Skip condition:** If no `_docs/hidden/tasks/cleanup-*.md` files exist, skip this stage entirely.

For each cleanup file found:

**Prompt composition:**
1. Read `scripts/orchestrator/prompts/cleanup.md`
2. Replace `{{CLEANUP_FILE}}` with the cleanup file path
3. Read the relevant rule files (same stack detection as review)
4. Add `## Parent Context` with: brief summary of the review finding

**Launch:** `CLAUDECODE= claude -p - --model opus --output-format json --max-turns 10 --allowedTools "Read,Edit,Write,Bash,Glob,Grep" --dangerously-skip-permissions < {temp_file}`

If there are multiple cleanup files, launch them sequentially (not in parallel) to avoid edit conflicts.

### Stage 5: Commit

**Prompt composition:**
1. Read `scripts/orchestrator/prompts/commit.md`
2. Replace `{{BREADCRUMBS}}` with the list of task files: `_docs/hidden/tasks/current.md` and any `cleanup-*.md` files
3. Add `## Parent Context` with: one-line summary of what this slice accomplished

**Launch:** `CLAUDECODE= claude -p - --model haiku --output-format json --max-turns 5 --allowedTools "Bash,Read,Glob,Grep" --dangerously-skip-permissions < {temp_file}`

**After commit:** Rotate task files:
1. Append contents of `_docs/hidden/tasks/current.md` to `_docs/hidden/tasks/progress.md` (with a `---` separator)
2. Delete `_docs/hidden/tasks/current.md` and all `_docs/hidden/tasks/cleanup-*.md`
3. Clean up temp files: `rm /tmp/orchestrate-*.md`

### Loop

Increment the slice counter and repeat from Stage 1 until:
- The plan-slice stage writes `ALL_DONE`
- `--max-slices` is reached
- A subprocess fails (non-zero exit)

## Behavior Between Stages

You are the **supervisor**. Between every stage:

1. **Print status:** `[slice N/max] stage: description`
2. **Read task files** to understand what the subprocess did
3. **Run `git diff --stat`** to see file-level changes
4. **Carry forward context** — your observations become `## Parent Context` in the next prompt
5. **Make decisions:**
   - Skip cleanup if review found no issues
   - Re-run plan-slice (once) if slice quality is poor
   - Flag to user if implement doesn't meet acceptance criteria
   - Stop on subprocess failure — don't retry blindly
