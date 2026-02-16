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
Check `_docs/hidden/tasks/progress.md` for what's already been completed.

### Step 3: Create Task File
Read the plan and determine the next logical slice. Write `_docs/hidden/tasks/current.md` with:
- A clear title
- What to implement (specific files, functions, patterns)
- Acceptance criteria
- Constraints

### Step 4: Confirm
Show the user what you wrote and ask if they want to proceed with implementation.
