---
name: plan-slice
description: Break the next slice from a plan into an implementable task file.
---

# Plan Slice

Create the next implementable slice from a plan.

## When Invoked

### Step 1: Identify the Plan

If the user provided a plan file path, use it. Otherwise, check `_docs/hidden/tasks/current.md` for an active plan reference, or ask the user which plan to work from.

### Step 2: Read Progress

Gather context on what's already been done:

1. **Plan file status** — Read the plan file itself and look for status sections, completion markers, or phase tracking (plans track their own progress per CLAUDE.md conventions).
2. **Progress log** — If `_docs/hidden/tasks/progress.md` exists, read it. The orchestrator appends each completed slice here.
3. **Current task** — If `_docs/hidden/tasks/current.md` exists and contains a completed slice, note it.

### Step 3: Determine Completion

If all phases/steps in the plan are complete:
- Write **only** the text `ALL_DONE` to `_docs/hidden/tasks/current.md`.
- Tell the user the plan is fully implemented.
- Stop here.

### Step 4: Create Task File

Read the plan and determine the next logical slice. A good slice is:

- **One logical unit of work** that can be implemented and reviewed in a single session
- **Small enough** to produce a focused, reviewable diff (aim for 1-5 files changed)
- **Large enough** to be meaningful — don't split a single function across slices
- **Self-contained** — the codebase should be in a working state after the slice is done

Write `_docs/hidden/tasks/current.md` with:

```markdown
# <Clear Title>

## Context
Why this slice is next. Reference the plan phase/step.

## What to Implement
- Specific files to create/modify
- Functions, types, or patterns to add
- Integration points with existing code

## Acceptance Criteria
- [ ] <Observable, testable outcome>
- [ ] <Another concrete check>
- [ ] Existing tests still pass (if applicable)

## Constraints
- Any architectural boundaries, performance requirements, or gotchas
```

### Step 5: Confirm

Show the user what you wrote and ask if they want to proceed with implementation.
