# Cleanup 007: Phase 3 edit popover UI is unspec'd

**Category:** Specificity — plan not implementable unambiguously
**File:** `_docs/designs/inline-review-v2.md` (Phase 3)
**Severity:** Low — Phase 3 is future work, but the sequence diagram implies a designed component

## What's Wrong

The Phase 3 sequence diagram shows:
```
Toolbar → Popover: Open with chunk.insertedText
Writer → Popover: Edit suggestion text
Writer → Popover: Click "Done"
```

This implies a "Mini CM6 Popover" component, but the design provides no specification for it:
- **Positioning**: Where does it appear? Above the hunk? Inline? Modal?
- **Size**: Fixed dimensions? Resizable? Auto-sized to content?
- **Editor instance**: A full CM6 editor inside? A textarea? ContentEditable?
- **Keyboard handling**: How does Escape work (close popover vs CM6 escape)? How does Ctrl-Enter work (accept vs submit)?
- **Commit flow**: What validates the edit? Can the writer leave it empty?
- **Cancel flow**: How does the writer cancel without applying? Click outside? Escape?
- **Multiple edits**: Can the writer have multiple edit popovers open?

The data flow is well-handled (infrastructure exists in `chunk-editor.ts` + `partial-apply.ts`), but the UI component is the hard part.

## Suggested Fix

Either:
1. **Add a Phase 3 UI spec** with a wireframe/mockup and the answers to the questions above
2. **Or explicitly mark Phase 3 as "design TBD"** — don't include a sequence diagram that implies a designed solution when the component isn't spec'd

The sequence diagram sets an expectation of design completeness that isn't met.
