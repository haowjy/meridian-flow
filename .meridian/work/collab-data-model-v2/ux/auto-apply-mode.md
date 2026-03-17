---
detail: standard
audience: developer, designer
---
# Auto-Apply Mode

In auto-apply mode, AI edits land on canonical immediately. The writer doesn't review before changes appear -- they see edits happen in real time and revert what they don't like.

## How It Differs from Manual Mode

| Aspect | Manual mode | Auto-apply mode |
|--------|-------------|-----------------|
| When AI proposes | Stored as pending, shown as inline diff | Applied immediately to canonical |
| Writer sees | Deletion/insertion highlights with Accept/Reject | Text changes live, like watching someone type |
| Writer action | Accept or reject each hunk | Undo what they don't like |
| Undo mechanism | Session Ctrl-Z or thread undo | Same -- both work |
| Default status | `pending` until acted on | `accepted` on arrival |

## Walkthrough

### 1. AI Edit Lands

Writer is watching the document while AI works. AI sends `edit_document`:

```
Before: "The cat sat on the mat."
After:  "The black cat sat on the mat."

Proposal created with status = 'accepted' (auto-apply).
yjs_update applied to canonical immediately.
Writer sees the text change in real time.
```

No diff highlights. No Accept/Reject buttons. The text just changes.

### 2. Writer Doesn't Like It

Writer sees "black cat" and doesn't want it. Two options:

**Option A: Ctrl-Z (session undo)**

```
Ctrl-Z → reverts the auto-apply transaction
  Y.Text: "The black cat" → "The cat"
  Y.Map: delete(_proposal_status[P1]) → back to pending
  P1 reappears as a pending diff hunk (switches to manual-mode rendering)
```

Wait -- this means Ctrl-Z on an auto-applied edit shows it as a pending hunk? Yes. The undo reverts both the text change and the status. The proposal is back to `pending`, so the projection pipeline picks it up and renders it as an inline diff. The writer can now Accept (re-apply) or Reject.

**Option B: Thread undo (any time later)**

```
Click Undo on P1 in thread sidebar:
  Search for "The black cat" → found
  Replace with "The cat"
  Status → reverted

Thread UI: [Reverted] [Reapply]
```

### 3. Multiple Edits Streaming

AI sends 5 edits in quick succession. All land immediately:

```
+--------------------------------------------------------------------+
|  Writer sees text changing in real time as AI streams edits:         |
|                                                                      |
|  "Pale morning light sliced through the gap in the curtains.        |
|   Sarah reached for her phone. 9:14. She stumbled into the          |
|   kitchen. The coffee maker sat on the counter, unplugged.          |
|   Of course. She stared at the outlet. Didn't move."               |
|                                                                      |
+--------------------------------------------------------------------+
```

Thread sidebar shows each edit with `[Accepted] [Undo]`. Writer can undo any individual edit from the thread.

### 4. Ctrl-Z Stack in Auto-Apply

```
Undo stack (most recent first):
  [5] Auto-apply P5   (ORIGIN_ACCEPT)
  [4] Auto-apply P4   (ORIGIN_ACCEPT)
  [3] Writer typed "x" (ORIGIN_HUMAN)    <-- writer typed between AI edits
  [2] Auto-apply P2   (ORIGIN_ACCEPT)
  [1] Auto-apply P1   (ORIGIN_ACCEPT)

Ctrl-Z sequence:
  1st → undoes P5 (reverts to pending, shows as diff hunk)
  2nd → undoes P4 (same)
  3rd → undoes "x" (removes writer's typing)
  4th → undoes P2 (reverts to pending)
```

AI edits and human typing interleave naturally in one stack.

## When to Use Which Mode

| Situation | Mode | Why |
|-----------|------|-----|
| Writer trusts the AI, wants speed | Auto-apply | See results instantly, undo the rare miss |
| Writer wants control, AI is experimental | Manual | Review each change before it lands |
| Quick fixes (typos, formatting) | Auto-apply | Low risk, high throughput |
| Structural rewrites | Manual | High stakes, want to evaluate each change |

The mode is per-user and can be changed at any time. Changing mode calls `undoManager.clear()` to prevent cross-mode undo confusion.

## Edge Case: Mode Switch Mid-Session

Writer starts in auto-apply. Three edits land automatically. Writer switches to manual mode.

```
Before switch:
  P1, P2, P3 all accepted (auto-applied)
  Undo stack has 3 entries

After switch:
  undoManager.clear()  -- undo stack emptied
  P1, P2, P3 remain accepted (they're in canonical)
  Thread undo still works for all three

New AI edits arrive as pending (manual mode).
```

The mode switch is a clean break. Old auto-applied edits can only be reverted via thread undo.

## Cross-References

- [Architecture](../spec/architecture.md) -- two collaboration modes
- [Undo Design](../spec/undo.md) -- undoManager.clear() on mode change
- [Thread Undo](thread-undo.md) -- revert auto-applied edits via thread
