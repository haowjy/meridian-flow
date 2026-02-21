# Cleanup 006: !important usage in CSS

**Category:** Project Conventions
**File:** `_docs/designs/inline-review-v2.md` (Phase 1 CSS section)
**Severity:** Low — CSS smell, not a bug

## What's Wrong

```css
.cm-review-active {
  position: relative;
  padding-bottom: 80px !important;
}
```

`!important` is generally discouraged:
- Hard to override if another extension or theme needs different padding
- Escalates specificity wars
- The CLAUDE.md principles say "Start Simple, Stay Simple" — `!important` is a complexity escape hatch

## Suggested Fix

Use a more specific selector or a CSS custom property:

```css
/* Option A: Higher specificity without !important */
.cm-editor.cm-review-active .cm-scroller {
  padding-bottom: 80px;
}

/* Option B: CSS custom property for overridability */
.cm-review-active {
  position: relative;
  padding-bottom: var(--review-bottom-padding, 80px);
}
```

Or consider whether `80px` is even needed — the floating ProposalReviewToolbar at `bottom-4` may work with the editor's existing padding if it's positioned fixed or absolute relative to the viewport rather than the editor content.
