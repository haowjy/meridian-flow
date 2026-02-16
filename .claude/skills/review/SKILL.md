---
name: review
description: Review recent changes for dead code, SOLID violations, reliability issues, and consistency.
---

# Code Review

Review working tree changes and create cleanup subtasks.

## When Invoked

### Step 1: Check Changes
Run `git diff` and `git status` to see what changed.

### Step 2: Review
Check for:
1. Dead code that should be removed
2. SOLID principle violations
3. Reliability issues (error handling, race conditions)
4. Consistency with existing codebase patterns (check CLAUDE.md conventions)

### Step 3: Create Subtasks
For each issue found, create a cleanup file: `_docs/hidden/tasks/cleanup-NNN.md` describing the issue and fix.

### Step 4: Report
Summarize findings. If no issues, say so.
