---
name: backlog
description: Review and update the refactoring backlog. Discovers new technical debt and tracks progress on existing items.
---

# Backlog Manager

Review, update, and work on the refactoring backlog.

## When Invoked

### Step 1: Read Current Backlog
Read `_docs/future/refactoring-backlog.md` to understand current items.

### Step 2: Determine Mode

**If user says "update" or "review":**
1. Scan recently modified files (use git diff or check current branch changes)
2. Look for new refactoring opportunities:
   - Files > 500 lines (SRP violations)
   - Duplicate code patterns
   - Inconsistent error handling
   - Large interfaces that could be split
3. Present findings and ask if they should be added to backlog

**If user says "work on" or "fix":**
1. Show prioritized list of backlog items
2. Ask which item to work on
3. Implement the refactor
4. Mark item as complete (✅) when done

**If no specific action:**
1. Show summary: X items total, Y high priority
2. Ask what the user wants to do:
   - Review/update backlog
   - Work on an item
   - Just view current state

### Step 3: Update Backlog File
After any changes, update `_docs/future/refactoring-backlog.md`:
- Add new items discovered
- Mark completed items with ✅
- Update locations if code moved
