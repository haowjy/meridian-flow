---
name: backlog
description: Review and update the refactoring backlog. Discovers new technical debt and tracks progress on existing items.
---

# Backlog Manager

Review, update, and work on the refactoring backlog.

## When Invoked

### Step 1: Read Current Backlog

Find the project's refactoring backlog. Look in project instruction files (`CLAUDE.md` or `AGENTS.md`) for a backlog location, or search for files like `refactoring-backlog.md` or `tech-debt.md` in documentation directories.

### Step 2: Determine Mode

**If user says "update" or "review":**

1. Scan recently modified files (use git diff or check current branch changes)
2. Look for refactoring opportunities using the review rules in the `review` skill's `references/general.md` — key signals:
   - Files > 500 lines (SRP violations)
   - Duplicate code patterns (consolidation needed)
   - Inconsistent error handling (swallowed errors, silent defaults)
   - Large interfaces that could be split (ISP)
   - Premature abstractions or missing shared utilities
3. **Dedup check**: Before proposing a new item, compare it against existing backlog entries. Skip items that are already tracked (same location or same refactor intent).
4. **Classify priority**:
   - **High** — Affects correctness or reliability (race conditions, swallowed errors, data bugs)
   - **Medium** — Architecture or maintainability (SRP violations, missing abstractions, ISP issues)
   - **Low** — Style or cleanup (naming, dead code, minor inconsistencies)
5. Present findings and ask if they should be added to backlog

**If user says "work on" or "fix":**

1. Show prioritized list of backlog items
2. Ask which item to work on
3. Implement the refactor
4. Mark item as complete (✅) when done

**If no specific action:**

1. Show summary: X items total, Y high priority, Z completed
2. Ask what the user wants to do:
   - Review/update backlog
   - Work on an item
   - Just view current state

### Step 3: Update Backlog File

After any changes, update the backlog file using the existing table format:

```markdown
| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| <What's wrong> | `file.go:lines` | <What to do> | ⬜ |
```

- Add new items to the correct stack section (Backend / Frontend) and priority level (High / Medium / Low)
- Mark completed items: ⬜ -> ✅
- Update locations if code moved
