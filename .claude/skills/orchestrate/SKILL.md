---
name: orchestrate
description: Run the plan-slice pipeline. Iterates stages (plan → implement → review → cleanup → commit) using opus subagents.
allowed-tools: Bash(git *), Bash(go build *), Bash(go test *), Bash(mkdir *), Bash(rm *), Read, Edit, Write, Glob, Grep, Task
---

# Orchestrate

Run an automated plan-slice pipeline using opus subagents.

## Usage

```
/orchestrate <plan-file> [--max-slices N] [--start-at stage]
```

- `plan-file` — path to the plan markdown file (required)
- `--max-slices N` — cap total slice iterations (default: 20)
- `--start-at stage` — resume from a specific stage: `plan|implement|review|cleanup|commit`

## Pipeline

Each slice iterates 5 stages. Communication happens via task files in `_docs/hidden/tasks/`.

### Stage 1: Plan Slice

Launch an opus subagent to read the plan and create the next implementable slice.

**Prompt:**
```
Read the plan at {PLAN_FILE}.

Gather progress context:
1. Read the plan file's status sections for completion tracking.
2. If _docs/hidden/tasks/progress.md exists, read it for previously completed slices.
3. If _docs/hidden/tasks/current.md exists and has a completed slice, note it.

If all phases/steps in the plan are complete, write ONLY the text 'ALL_DONE' to _docs/hidden/tasks/current.md and stop.

Otherwise, create the next implementable slice — one logical unit of work (aim for 1-5 files changed) that leaves the codebase in a working state.

Write _docs/hidden/tasks/current.md with:
- A clear title
- Context: why this slice is next (reference plan phase/step)
- What to implement (specific files, functions, patterns)
- Acceptance criteria (observable, testable outcomes as checkboxes)
- Constraints
```

**After the subagent returns:** Read `_docs/hidden/tasks/current.md`. If it contains only `ALL_DONE`, stop the pipeline and tell the user the plan is fully implemented.

### Stage 2: Implement

Launch an opus subagent to implement the task.

**Prompt:**
```
Read the task at _docs/hidden/tasks/current.md and implement it.

Follow the project conventions in CLAUDE.md. Write clean, correct code.
When done, append a '## Completed' section to _docs/hidden/tasks/current.md describing what you did.
```

### Stage 3: Review

Launch an opus subagent to review the changes.

**Prompt:**
```
Review the changes in the working tree (use git diff).

Check for:
1. Dead code that should be removed
2. SOLID principle violations
3. Reliability issues (error handling, race conditions)
4. Consistency with existing codebase patterns

For each issue found, create a cleanup subtask file: _docs/hidden/tasks/cleanup-NNN.md
Each file should describe the specific issue and the fix needed.
If no issues found, create no files.
```

### Stage 4: Cleanup

Check for `_docs/hidden/tasks/cleanup-*.md` files. For each one, launch an opus subagent:

**Prompt:**
```
Read and implement the cleanup task at _docs/hidden/tasks/{CLEANUP_FILE}.
Keep changes minimal and focused.
```

If no cleanup files exist, skip this stage.

### Stage 5: Commit

Launch an opus subagent to create a commit.

**Prompt:**
```
Review all changes in the working tree (git diff, git status).

Read these task files for context on what was implemented and why:
- _docs/hidden/tasks/current.md
- Any _docs/hidden/tasks/cleanup-*.md files that exist

Create a clear, concise commit message that summarizes the 'why' not just the 'what'.
Stage all relevant files and commit. Do NOT push.
```

**After the commit subagent returns:** Rotate task files:
1. Append contents of `_docs/hidden/tasks/current.md` to `_docs/hidden/tasks/progress.md` (with a separator)
2. Delete `_docs/hidden/tasks/current.md` and all `_docs/hidden/tasks/cleanup-*.md` files

### Loop

Increment the slice counter and repeat from Stage 1 until:
- The plan agent writes `ALL_DONE`
- `--max-slices` is reached
- An error occurs

## Execution Notes

- All subagents should be `subagent_type: "general-purpose"` with `model: "opus"`
- Run cleanup subagents in parallel if there are multiple cleanup files
- Create `_docs/hidden/tasks/` directory if it doesn't exist before starting
- Print a status line between stages so the user can follow progress: `[slice N/max] stage: description`
- If a subagent fails, stop the pipeline and report the error — don't retry blindly
