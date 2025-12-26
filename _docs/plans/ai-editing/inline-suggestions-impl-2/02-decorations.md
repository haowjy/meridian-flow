# Phase 2: Decorations

## Goal

Build the CodeMirror ViewPlugin that:
1. **Always hides PUA markers** from display (replacing them with zero-width) whenever the merged doc is shown
2. Styles deletion regions as red strikethrough + insertion regions as green underline

> There are no modes. This plugin targets the single merged review view.

## What You're Building

The decorations layer makes the merged document look like a clean inline diff. The PUA markers are still in the document (important for CM6 history), but users don't see them.

```
Document:  "\uE000She felt sad.\uE001\uE002A heavy melancholia.\uE003 The rain..."
Display:   "~~She felt sad.~~ A heavy melancholia. The rain..."
                            ↑ markers hidden, regions styled
```

## Behavior Summary

- Markers are always hidden
- Deletions are styled as red strikethrough
- Insertions are styled as green underline

## Steps

### Step 2.1: Add CSS styling

Add to `frontend/src/globals.css`:

```css
/* ==========================================================================
   AI Diff View Decorations
   ========================================================================== */

/**
 * Deleted text - shown as red strikethrough
 * This is original content that AI wants to replace
 */
.cm-ai-deletion {
  text-decoration: line-through;
  color: var(--error);
  background-color: color-mix(in srgb, var(--error) 10%, transparent);
  border-radius: 2px;
}

/**
 * Inserted text - shown as green underline
 * This is AI-suggested replacement text
 */
.cm-ai-insertion {
  text-decoration: underline;
  text-decoration-color: hsl(142.1 76.2% 36.3%); /* green-600 */
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
  background-color: hsl(142.1 76.2% 36.3% / 0.1);
  border-radius: 2px;
}

/**
 * PUA markers - hidden from display
 * These are replaced with zero-width spans
 */
.cm-pua-marker {
  display: none;
}

/**
 * Currently focused hunk (for navigation)
 */
.cm-ai-hunk-focused {
  outline: 2px solid hsl(var(--primary));
  outline-offset: 1px;
}

/**
 * Hunk action buttons container
 */
.cm-hunk-actions {
  display: inline-flex;
  gap: 2px;
  margin-left: 4px;
  vertical-align: middle;
  opacity: 0;
  transition: opacity 150ms ease-in-out;
}

/* Show on line hover */
.cm-line:hover .cm-hunk-actions {
  opacity: 1;
}

/* Always show for focused hunk */
.cm-hunk-actions[data-focused="true"] {
  opacity: 1;
}

.cm-hunk-actions button {
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 150ms;
}

.cm-hunk-accept {
  background: hsl(142.1 76.2% 36.3%);
  color: white;
}

.cm-hunk-accept:hover {
  background: hsl(142.1 76.2% 30%);
}

.cm-hunk-reject {
  background: var(--error);
  color: var(--error-foreground);
}

.cm-hunk-reject:hover {
  opacity: 0.9;
}
```

---

### Step 2.2: Create the decoration plugin

Create `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

```typescript
/**
 * Diff View Plugin
 *
 * Creates decorations to:
 * 1. Always hide PUA marker characters (replace with zero-width spans)
 * 2. Style deletion + insertion regions
 */

import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  EditorView,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { MARKERS, extractHunks, type MergedHunk } from '@/features/documents/utils/mergedDocument'

// =============================================================================
// MARKER HIDING WIDGET
// =============================================================================

/**
 * Zero-width widget that replaces PUA markers.
 * The marker is still in the document, but this widget has no visual width.
 */
class MarkerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-pua-marker'
    return span
  }

  eq(): boolean {
    return true  // All marker widgets are equivalent
  }
}

const markerWidget = new MarkerWidget()

// =============================================================================
// DECORATION BUILDERS
// =============================================================================

/**
 * Create decorations for a single hunk.
 */
function createHunkDecorations(
  hunk: MergedHunk,
  builder: RangeSetBuilder<Decoration>
): void {
  // 1. Hide DEL_START marker
  builder.add(
    hunk.delStart,
    hunk.delStart + 1,
    Decoration.replace({ widget: markerWidget })
  )

  // 2. Style deletion content (if any)
  if (hunk.deletedText.length > 0) {
    builder.add(
      hunk.delStart + 1,  // After DEL_START
      hunk.delEnd,        // Before DEL_END
      Decoration.mark({ class: 'cm-ai-deletion' })
    )
  }

  // 3. Hide DEL_END marker
  builder.add(
    hunk.delEnd,
    hunk.delEnd + 1,
    Decoration.replace({ widget: markerWidget })
  )

  // 4. Hide INS_START marker
  builder.add(
    hunk.insStart,
    hunk.insStart + 1,
    Decoration.replace({ widget: markerWidget })
  )

  // 5. Style insertion content (if any)
  if (hunk.insertedText.length > 0) {
    builder.add(
      hunk.insStart + 1,  // After INS_START
      hunk.insEnd,        // Before INS_END
      Decoration.mark({ class: 'cm-ai-insertion' })
    )
  }

  // 6. Hide INS_END marker
  builder.add(
    hunk.insEnd,
    hunk.insEnd + 1,
    Decoration.replace({ widget: markerWidget })
  )
}

// =============================================================================
// VIEW PLUGIN
// =============================================================================

class DiffViewPluginClass {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view)
  }

  update(update: ViewUpdate) {
    // Rebuild decorations when:
    // - Document changes (hunk positions shift)
    // - Viewport changes (scrolling can reveal un-decorated markers if culling is used)
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  buildDecorations(view: EditorView): DecorationSet {
    // Extract hunks from current document
    // Note: We could use config.hunks, but extracting fresh ensures
    // positions are always accurate after edits
    const doc = view.state.doc.toString()
    const hunks = extractHunks(doc)

    if (hunks.length === 0) {
      return Decoration.none
    }

    const builder = new RangeSetBuilder<Decoration>()

    // Use extended viewport with buffer to prevent marker flash on scroll
    // PUA markers would briefly appear as the viewport expands during scroll
    const VIEWPORT_BUFFER = 2000  // characters
    const viewFrom = Math.max(0, view.viewport.from - VIEWPORT_BUFFER)
    const viewTo = Math.min(doc.length, view.viewport.to + VIEWPORT_BUFFER)

    // Process each hunk (they're already sorted by position)
    // createHunkDecorations handles hiding markers + styling regions
    for (const hunk of hunks) {
      // Skip hunks outside extended viewport for performance
      if (hunk.to < viewFrom || hunk.from > viewTo) {
        continue
      }

      createHunkDecorations(hunk, builder)
    }

    return builder.finish()
  }

  destroy() {
    // No cleanup needed
  }
}

/**
 * The diff view ViewPlugin.
 *
 * Note: We don't need EditorView.atomicRanges because Decoration.replace
 * widgets already prevent the cursor from landing on replaced content.
 */
export const diffViewPlugin = ViewPlugin.fromClass(DiffViewPluginClass, {
  decorations: v => v.decorations,
})

// =============================================================================
// EXTENSION BUNDLE
// =============================================================================

/**
 * Create the diff view extension bundle.
 *
 * NOTE: This is the Phase 2 version. Phase 5 extends this function to accept
 * an optional keymapCallbacks parameter for navigation shortcuts:
 *   createDiffViewExtension(callbacks?: DiffKeymapCallbacks): Extension
 *
 * @returns Extension array with view plugin
 *
 * @example
 * ```typescript
 * // In EditorPanel, wrap in a Compartment for dynamic reconfiguration
 * const diffCompartment = new Compartment()
 *
 * // Initial: empty
 * extensions: [diffCompartment.of([])]
 *
 * // Enable diff view:
 * view.dispatch({
 *   effects: diffCompartment.reconfigure(createDiffViewExtension())
 * })
 *
 * ```
 */
export function createDiffViewExtension(): Extension {
  return [
    diffViewPlugin,
    // Edit filter added in Phase 3
    // Keymap with callbacks added in Phase 5
  ]
}
```

---

### Step 2.3: Update the index.ts exports

Update `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 */

// Plugin and extension
export { diffViewPlugin, createDiffViewExtension } from './plugin'
```

---

### Step 2.4: Test the decorations

Temporary test code for EditorPanel:

```typescript
import { Compartment } from '@codemirror/state'
import { createDiffViewExtension } from '@/core/editor/codemirror/diffView'
import { buildMergedDocument, extractHunks } from '@/features/documents/utils/mergedDocument'

// Create compartment (once, at module level or in a ref)
const diffCompartment = new Compartment()

// Build test document
const content = "She felt sad. The rain fell."
const aiVersion = "A heavy melancholia. The rain continued."
const merged = buildMergedDocument(content, aiVersion)
const hunks = extractHunks(merged)

console.log('Merged document:', JSON.stringify(merged))
console.log('Hunks:', hunks)

// In your editor initialization:
// extensions: [diffCompartment.of(createDiffViewExtension())]

// You should see:
// - PUA markers hidden (no weird characters visible)
// - "She felt sad." in red strikethrough
// - "A heavy melancholia." in green underline
// - "fell" in red, "continued" in green
```

---

## Understanding the Decoration Flow

```
Document with PUA markers
        │
        ▼
┌───────────────────────────┐
│  extractHunks(doc)        │  Extract positions from markers
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  For each hunk:           │
│  - Hide 4 markers         │  Decoration.replace with zero-width widget
│  - Style DEL content      │  Decoration.mark with cm-ai-deletion
│  - Style INS content      │  Decoration.mark with cm-ai-insertion
└───────────────────────────┘
        │
        ▼
┌───────────────────────────┐
│  User sees clean diff     │  Markers invisible, content styled
└───────────────────────────┘
```

---

## Verification Checklist

Before moving to Phase 3, verify:

- [ ] CSS classes added to `globals.css`
- [ ] `plugin.ts` created with ViewPlugin
- [ ] `index.ts` updated with exports
- [ ] PUA markers are hidden (not visible in editor)
- [ ] Deletion text appears with red strikethrough
- [ ] Insertion text appears with green underline
- [ ] Decorations rebuild after document changes

## Troubleshooting

**Markers still visible?**
1. Check CSS `.cm-pua-marker { display: none }` is loaded
2. Verify the replace decorations are being created
3. Check hunk positions are correct

**Wrong styling positions?**
1. Log the hunks from `extractHunks()` and verify positions
2. Check that marker positions account for the 1-character width
3. Ensure decorations are added in position order

**Performance issues?**
1. Check viewport culling is working (hunks outside viewport skipped)
2. Consider memoizing hunk extraction if document hasn't changed

**Performance Note:** For large documents (>100KB) with many hunks (>50), profile `extractHunks()` during typing. PUA marker scanning is O(n) but should be fast due to unique character codes. If needed, optimize by:
- Caching hunk positions and using CM6 transaction mapping to update them incrementally
- Throttling decoration rebuilds during rapid typing
- Using binary search on cached marker positions

## Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/globals.css` | Modified (added diff styles) |
| `frontend/src/core/editor/codemirror/diffView/plugin.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Modified |

## Next Step

→ Continue to `03-edit-handling.md` to implement the edit filter that blocks edits in deletion regions.
