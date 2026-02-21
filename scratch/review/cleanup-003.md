# Cleanup 003: Missing mechanism to apply `.cm-review-active` class to editor container

**Category:** Specificity — plan cannot be implemented unambiguously
**File:** `_docs/designs/inline-review-v2.md` (Phase 1 CSS section)
**Severity:** High — the floating toolbar positioning depends on this class

## What's Wrong

The CSS defines:
```css
.cm-review-active {
  position: relative;
  padding-bottom: 80px !important;
}
```

The floating `.cm-review-actions` uses `position: absolute`, which requires its containing block to have `position: relative`. The design assumes `.cm-review-active` is on the editor's container element — but **no code adds or removes this class**.

Questions left unanswered:
1. Which DOM element gets this class? (`.cm-editor`? `.cm-content`? A wrapper div?)
2. When is it applied? (When review chunks are loaded? When hover occurs?)
3. When is it removed? (When all chunks are resolved? When review is cleared?)
4. What mechanism applies it? (A CM6 EditorView.editorAttributes extension? A React wrapper? Direct DOM manipulation?)

Without this, the absolute positioning of `.cm-review-actions` has no containing block and will position relative to the viewport or nearest positioned ancestor — which is likely wrong.

## Suggested Fix

Add a section specifying the mechanism. The cleanest CM6 approach is `EditorView.editorAttributes`:

```typescript
const reviewActiveAttr = EditorView.editorAttributes.compute(
  [inlineReviewField],
  (state) => {
    const review = state.field(inlineReviewField);
    const hasPending = review.chunks.some(c => !review.resolutions.has(c.id));
    return hasPending ? { class: "cm-review-active" } : {};
  }
);
```

This adds the class to `.cm-editor` when review chunks are present and removes it when all are resolved. Add this to the extension array in `inlineReviewExtension()`.
