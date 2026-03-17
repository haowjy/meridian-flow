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
  status: accepted
```

## Undo: Accepted -> Reverted

Writer clicks **Undo** on P1 in the thread sidebar.

```
Step 1: Search canonical for region_text_after
  "Pale morning light sliced through the gap in the curtains"
  Found at position 0. ✓

Step 2: Yjs transaction (ORIGIN_THREAD)
  - Delete match
  - Insert region_text_before
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
Step 1: Search canonical for region_text_before
  "The morning light filtered through the curtains"
  Found. ✓

Step 2: Yjs transaction (ORIGIN_THREAD)
  - Delete match
  - Insert region_text_after
  - Set _proposal_status[P1] = 'accepted'

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
  status: rejected

Writer clicks Reapply:
  Search for region_text_before → found → replace → status = accepted
```

## Conflict: Text Was Edited

Writer accepted P1, then manually edited the region:

```
Canonical after manual edit:
  "Weak morning light sliced through the gap in the curtains."
                                      (writer changed "Pale" to "Weak")

Writer clicks Undo on P1:
  Search for "Pale morning light sliced through the gap in the curtains"
  NOT FOUND. ✗

Thread UI shows: [Undo failed -- text was edited]
```

The conflict is expected and correct. The writer's manual edit took precedence. P1 stays accepted but is no longer undoable via thread.

## Undo All

Writer wants to revert everything the AI did in one thread:

```
Thread has P1 (accepted), P3 (accepted), P4 (accepted).

"Undo All" iterates in reverse chronological order (newest first):
  P4: search for region_text_after → found → reverted ✓
  P3: search for region_text_after → found → reverted ✓
  P1: search for region_text_after → found → reverted ✓

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

## What the Writer Sees

### Thread Sidebar

```
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

- [Undo Design](../spec/undo.md) -- thread undo mechanics, conflict handling
- [Local-First Authority](../spec/local-first-authority.md) -- ORIGIN_THREAD transactions
- [Proposal Review](proposal-review.md) -- the initial review flow
