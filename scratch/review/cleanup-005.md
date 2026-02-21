# Cleanup 005: Event handling changed from mousedown to onclick without rationale

**Category:** Reliability — behavioral change not discussed
**File:** `_docs/designs/inline-review-v2.md` (Phase 1, HunkActionWidget code)
**Severity:** Low-Medium — could introduce subtle focus/timing bugs

## What's Wrong

The current `ChunkActionWidget` uses `mousedown` with `preventDefault()`:
```typescript
// Current code (inline-review.ts:135-138)
acceptBtn.addEventListener("mousedown", (e) => {
  e.preventDefault(); // prevent editor focus loss
  this.callbacks.onAcceptChunk(this.chunk);
});
```

The design's `HunkActionWidget` switches to `onclick`:
```typescript
// Proposed code
acceptBtn.onclick = (e) => {
  e.preventDefault();
  e.stopPropagation();
  this.callbacks.onAcceptChunk(this.chunk);
};
```

Behavioral differences:
1. **Timing**: `mousedown` fires on press (instant feedback); `onclick` fires after release (standard button feel but ~100ms slower)
2. **Focus**: `mousedown + preventDefault` prevents CM6 from processing the mousedown, preserving editor focus. With `onclick`, the browser processes the mousedown first — could blur the editor before the click handler fires
3. **Event model**: `addEventListener` vs `onclick` property — the latter is a single-handler pattern (fine here but different)

The design compensates with `ignoreEvent() { return true }`, which tells CM6 not to handle events from this widget. This should prevent CM6 from processing the mousedown. But this interaction (ignoreEvent + onclick + absolutely-positioned element) is subtly different from the current approach and deserves explicit discussion.

## Suggested Fix

Add a brief note explaining the event handling change:
> The widget changes from `mousedown` to `onclick` because the floating toolbar is absolutely positioned outside the editor's content flow. `ignoreEvent() { return true }` ensures CM6 doesn't process any events from the widget. `onclick` provides standard button UX (activation on release, compatible with drag-to-cancel).

Alternatively, keep `mousedown` for consistency with the existing pattern — it's proven to work.
