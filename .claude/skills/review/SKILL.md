---
name: review
description: Review recent changes against project rules. Loads stack-specific rule files based on changed files.
---

# Code Review

Review working tree changes against curated project rules and create cleanup subtasks.

## When Invoked

### Step 1: Detect Scope

Run `git diff --name-only` and `git status` to determine:
- What files changed
- Which stacks are affected (`backend/`, `frontend/`, or both)

### Step 2: Load Rules

Read the relevant rule files based on changed files:
- **Always** load `.claude/skills/review/rules/general.md`
- If `backend/` files changed → also load `.claude/skills/review/rules/backend.md`
- If `frontend/` files changed → also load `.claude/skills/review/rules/frontend.md`

### Step 3: Review Against Categories

Check the diff against these categories, using the loaded rules as your checklist:

1. **Correctness** — logic errors, edge cases, missing branches, wrong comparisons, off-by-one
2. **Security** — hardcoded secrets, injection risks, missing auth checks, sensitive data in logs
3. **Reliability** — error handling, race conditions, resource cleanup, missing guards
4. **Architecture** — SOLID violations, import boundaries, coupling, cross-file breakage
5. **Dead code & Complexity** — unused code/imports, overly nested logic, premature abstractions
6. **Project conventions** — violations of rules from the loaded rule files

### Step 4: Create Subtasks

For each issue found, create a cleanup file: `_docs/hidden/tasks/cleanup-NNN.md` describing:
- The category (from Step 3)
- The file and location
- What's wrong and why
- Suggested fix

### Step 5: Report

Summarize findings grouped by category. If no issues, say so.
