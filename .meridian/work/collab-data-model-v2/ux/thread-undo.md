---
detail: standard
audience: developer, designer
---
# Thread Undo Flow

Writer reverts or reapplies an accepted edit days after the original review, via the thread UI. This is separate from session Ctrl-Z (which only covers the current editing session).

## Setup

Writer accepted P1 three days ago. Document has been edited since.

```
Current canonical:
  "Pale morning light sliced through the gap in the curtains. Sarah
   reached for her phone, checking the time. It was already past nine."

P1's stored data:
  region_text_before: "The morning light filtered through the curtains"
  region_text_after:  "Pale morning light sliced through the gap in the curtains"
  accepted_at_offset: 0
  status: accepted
```

## Undo: Accepted -> Reverted

Writer clicks **Undo** on P1 in the thread sidebar.

```
Step 1: Search near offset 0 for region_text_after
  "Pale morning light sliced through the gap in the curtains"
  Found at position 0. ✓

Step 2: Yjs transaction (ORIGIN_THREAD)
  - Delete match, insert region_text_before
  - Set _proposal_status[P1] = 'reverted'

Step 3: Result
  "The morning light filtered through the curtains. Sarah reached
   for her phone, checking the time. It was already past nine."
```

Thread UI updates:

```
Before:  AI: edit_document("Vivid opening")  [Accepted]  [Undo]
After:   AI: edit_document("Vivid opening")  [Reverted]  [Reapply]
```

This transaction enters the session undo stack -- Ctrl-Z can reverse it immediately.

## Reapply: Reverted -> Accepted

Writer changes their mind. Clicks **Reapply**.

```
Step 1: Search near stored offset for region_text_before
  "The morning light filtered through the curtains"
  Found. ✓

Step 2: Yjs transaction (ORIGIN_THREAD)
  - Delete match, insert region_text_after
  - Set _proposal_status[P1] = 'accepted'
  - Record new accepted_at_offset for future undo

Step 3: Result
  "Pale morning light sliced through the gap in the curtains. Sarah..."
```

Thread UI: back to `[Accepted] [Undo]`.

## Reapply: Rejected -> Accepted

Same mechanism works for rejected proposals. Writer rejected P2 during review but later wants it:

```
P2 stored data:
  region_text_before: "checking the time. It was already past nine."
  region_text_after:  "checking the time. 9:14. Shit."
  proposed_at_offset: 78
  accepted_at_offset: NULL  (never accepted)
  status: rejected

Writer clicks Reapply:
  Search near proposed_at_offset (78) for region_text_before → found → replace → status = accepted
  accepted_at_offset set to landing position
```

## Conflict: Text Was Edited

Writer accepted P1, then manually edited the region:

```
Canonical after manual edit:
  "Weak morning light sliced through the gap in the curtains."
                                      (writer changed "Pale" to "Weak")

Writer clicks Undo on P1:
  Search near offset 0 for "Pale morning light sliced through the gap in the curtains"
  NOT FOUND. ✗

Thread UI shows: [Undo failed -- text was edited]
```

The conflict is expected and correct. The writer's manual edit took precedence. P1 stays accepted but is no longer undoable via thread.

## Undo All

Writer wants to revert everything the AI did in one thread:

```
Thread has P1 (accepted), P3 (accepted), P4 (accepted).

"Undo All" iterates in reverse chronological order (newest first):
  P4: search near offset for region_text_after → found → reverted ✓
  P3: search near offset for region_text_after → found → reverted ✓
  P1: search near offset for region_text_after → found → reverted ✓

Results:
  P1: reverted ✓
  P3: reverted ✓
  P4: reverted ✓
```

Reverse order minimizes avoidable conflicts -- a later proposal may have edited text introduced by an earlier one.

If some succeed and others conflict, the UI shows per-proposal results:

```
  P4: reverted ✓
  P3: conflict -- text was edited ✗
  P1: reverted ✓
```

## Turn-Level Restore

When per-proposal undo fails (e.g., conflict after the writer edited the region), the writer can restore the document to the state before the entire AI turn. If the turn edited multiple documents, all are restored together.

```
Thread has P1 (conflict on undo), P3 (accepted), P4 (accepted).
Turn also edited Chapter 5 with P6 (accepted).

Writer clicks "Restore to before this turn":
  1. Confirmation: "This will restore 2 document(s). All changes since
     this turn (including your edits) will be lost."
  2. Writer confirms.
  3. For each affected document:
     - Current state saved as safety_restore bookmark
     - Document restored to ai_turn bookmark
     - Undo stack cleared (Ctrl-Z won't work — use "Undo restore")
  4. P1, P3, P4, P6 return to pending — they re-appear as diff hunks
     for the writer to re-review.

Thread UI after restore:
  [Restored] [Undo restore]

Writer clicks "Undo restore":
  1. Each document restored to its safety_restore bookmark
  2. P1, P3, P4, P6 return to their pre-restore statuses
  3. Thread UI returns to normal per-proposal actions
```

Both buttons are only available while their bookmarks exist (pre-compaction). After compaction deletes the bookmarks, the buttons disappear from the thread UI. Per-proposal undo/reapply still works (it uses text search, not bookmarks).

## What the Writer Sees

### Thread Sidebar

```
Normal state:
+--------------------------------------------------+
|  AI Assistant - Chapter 4 Review                  |
|                                                    |
|  edit_document("Vivid opening")                   |
|  "Edit applied successfully"                      |
|  [Accepted] [Undo]                                |
|                                                    |
|  edit_document("Tighten time check")              |
|  "Edit applied successfully"                      |
|  [Rejected] [Reapply]                             |
|                                                    |
|  edit_document("Sharpen coffee detail")           |
|  "Edit applied successfully"                      |
|  [Accepted] [Undo]                                |
|                                                    |
|  edit_document("Action over dialogue")            |
|  "Edit applied successfully"                      |
|  [Accepted] [Undo]                                |
|                                                    |
|              [Undo All Accepted]                   |
|         [Restore to before this turn]              |
+--------------------------------------------------+

After restore:
+--------------------------------------------------+
|  AI Assistant - Chapter 4 Review                  |
|                                                    |
|  edit_document("Vivid opening")                   |
|  "Edit applied successfully"                      |
|  (pending — visible as diff hunk in editor)       |
|                                                    |
|  edit_document("Tighten time check")              |
|  "Edit applied successfully"                      |
|  (pending — visible as diff hunk in editor)       |
|                                                    |
|  ...                                               |
|                                                    |
|         [Restored] [Undo restore]                  |
+--------------------------------------------------+
```

The tool_result text ("Edit applied successfully") never changes -- thread messages are immutable. The status badges and action buttons are overlays derived from proposal row status.

### After Conflict

```
|  edit_document("Vivid opening")                   |
|  "Edit applied successfully"                      |
|  [Accepted] [Undo failed -- text was edited]      |
```

The failure message is transient UI state, not persisted.

## Cross-References

- [Undo Design](../spec/undo.md) -- thread undo mechanics, offset-anchored search
- [Local-First Authority](../spec/local-first-authority.md) -- ORIGIN_THREAD transactions
- [Proposal Review](proposal-review.md) -- the initial review flow
