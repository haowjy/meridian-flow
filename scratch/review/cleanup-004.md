# Cleanup 004: State machine missing Focused → Idle transition

**Category:** Specificity — incomplete interaction model
**File:** `_docs/designs/inline-review-v2.md` (Interaction State Machine section)
**Severity:** Medium — could leave toolbar stuck visible after keyboard navigation

## What's Wrong

The state machine defines transitions FROM Focused:
- `Focused → Focused: Ctrl-] / Ctrl-[` (navigate between hunks)
- `Focused → Resolving: Ctrl-Enter / Ctrl-Backspace` (accept/reject)
- `Focused → Hovered: mouseenter different hunk`

But there's **no way to exit Focused state** without:
1. Resolving the hunk (Ctrl-Enter/Backspace)
2. Navigating to a different hunk that the mouse happens to be over
3. Moving between hunks via keyboard forever

Missing transitions:
- **Escape → Idle**: Standard UI pattern for dismissing focused state
- **Click outside hunk → Idle**: User clicks in editor text outside any hunk region
- **All hunks resolved → [*]**: When accept-all clears everything, Focused should terminate

Without these, the floating toolbar stays pinned (via `cm-review-focused-visible`) even when the writer wants to just write. This breaks the "writer-first" philosophy — controls should get out of the way.

## Suggested Fix

Add to the state machine:
```
Focused --> Idle: Escape
Focused --> Idle: Click outside hunk
```

And add an Escape keymap handler in `makeInlineReviewKeymap`:
```typescript
{
  key: "Escape",
  run(view) {
    const state = view.state.field(inlineReviewField);
    if (state.activeChunkIndex >= 0) {
      view.dispatch({ effects: setActiveChunk.of(-1) });
      return true;
    }
    return false;
  },
}
```

The hover manager should also clear Focused state when detecting click outside any `[data-hunk-id]` region.
