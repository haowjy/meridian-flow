# Phase 2: Decorations

## Goal
Build the CodeMirror ViewPlugin that displays word-level diffs with:
- Red strikethrough for deletions (as ghost text)
- Green underline for insertions

## Key Concept: Ghost Deletions

The editor shows `aiVersion` as its document. But we need to also show deleted text (from `content`) that doesn't exist in `aiVersion`. We do this with **widget decorations** that insert visual-only content.

```
Editor doc (aiVersion):  "A heavy melancholia settled..."
Display:                 "S̶h̶e̶ ̶f̶e̶l̶t̶ ̶s̶a̶d̶.̶ A heavy melancholia settled..."
                          └── ghost widget (not in doc)
```

## Steps

### Step 2.1: Add CSS styling

Add to `frontend/src/globals.css`:

```css
/* ==========================================================================
   AI Diff View Decorations
   ========================================================================== */

/**
 * Deleted text (ghost widget)
 * Shown as red strikethrough - this text doesn't exist in the editor doc
 */
.cm-ai-deletion {
  text-decoration: line-through;
  color: hsl(var(--destructive));
  background-color: hsl(var(--destructive) / 0.1);
  border-radius: 2px;
  padding: 0 1px;
}

/**
 * Inserted text (mark decoration)
 * Shown as green underline - this text exists in the editor doc
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
  background: hsl(var(--destructive));
  color: hsl(var(--destructive-foreground));
}

.cm-hunk-reject:hover {
  opacity: 0.9;
}
```

---

### Step 2.2: Create the DeletionWidget

Create `frontend/src/core/editor/codemirror/diffView/DeletionWidget.ts`:

```typescript
import { WidgetType } from '@codemirror/view'

/**
 * Widget that displays deleted text as a ghost element.
 *
 * This text doesn't exist in the editor document - it's purely visual.
 * The widget is inserted at the position where the deletion occurred.
 */
export class DeletionWidget extends WidgetType {
  constructor(
    private readonly deletedText: string,
    private readonly hunkId: string
  ) {
    super()
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ai-deletion'
    span.textContent = this.deletedText
    span.dataset.hunkId = this.hunkId

    // Prevent cursor from entering the widget
    span.setAttribute('contenteditable', 'false')

    return span
  }

  /**
   * Compare widgets for equality.
   * Used by CodeMirror to avoid unnecessary DOM updates.
   */
  eq(other: DeletionWidget): boolean {
    return (
      other.deletedText === this.deletedText &&
      other.hunkId === this.hunkId
    )
  }

  /**
   * Estimate the visual length of the widget.
   * Used for cursor positioning calculations.
   */
  get estimatedHeight(): number {
    return -1 // Inline widget, no height contribution
  }

  /**
   * Whether the widget is a block widget.
   */
  get lineBreaks(): number {
    // Count line breaks in deleted text for proper height estimation
    return (this.deletedText.match(/\n/g) || []).length
  }

  /**
   * Widget should not be editable.
   */
  ignoreEvent(): boolean {
    return true
  }
}
```

---

### Step 2.3: Create the diff view plugin

Create `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

```typescript
/**
 * Diff View Plugin
 *
 * Displays word-level diffs between baseline (content) and AI version.
 * - Deletions: Ghost widgets with red strikethrough
 * - Insertions: Mark decorations with green underline
 */

import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { RangeSetBuilder, type Extension, Facet } from '@codemirror/state'
import type { WordDiffHunk, DiffViewConfig } from './types'
import { DeletionWidget } from './DeletionWidget'

// ============================================================================
// FACET FOR CONFIGURATION
// ============================================================================

/**
 * Facet to provide diff configuration to the plugin.
 * This allows the config to be updated without recreating the plugin.
 */
export const diffConfigFacet = Facet.define<DiffViewConfig, DiffViewConfig>({
  combine: (values) => values[values.length - 1] ?? {
    mode: 'changes',
    baseline: '',
    aiVersion: '',
    hunks: [],
    onAcceptHunk: () => {},
    onRejectHunk: () => {},
    onDualDocChange: () => {},
  },
})

// ============================================================================
// DECORATION BUILDERS
// ============================================================================

/**
 * Create a widget decoration for deleted text.
 */
function createDeletionDecoration(
  hunk: WordDiffHunk
): { pos: number; decoration: Decoration } | null {
  if (!hunk.deletedText) return null

  return {
    pos: hunk.displayFrom,
    decoration: Decoration.widget({
      widget: new DeletionWidget(hunk.deletedText, hunk.id),
      side: -1, // Before the insertion
    }),
  }
}

/**
 * Create a mark decoration for inserted text.
 */
function createInsertionDecoration(
  hunk: WordDiffHunk
): { from: number; to: number; decoration: Decoration } | null {
  if (!hunk.insertedText || hunk.displayFrom === hunk.displayTo) return null

  return {
    from: hunk.displayFrom,
    to: hunk.displayTo,
    decoration: Decoration.mark({
      class: 'cm-ai-insertion',
      attributes: { 'data-hunk-id': hunk.id },
    }),
  }
}

// ============================================================================
// VIEW PLUGIN
// ============================================================================

class DiffViewPlugin {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view)
  }

  update(update: ViewUpdate) {
    // Rebuild decorations when:
    // - Document changes
    // - Config changes (mode, hunks)
    // - Viewport changes (for performance, only render visible)
    const configChanged = update.state.facet(diffConfigFacet) !==
                          update.startState.facet(diffConfigFacet)

    if (update.docChanged || configChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  buildDecorations(view: EditorView): DecorationSet {
    const config = view.state.facet(diffConfigFacet)

    // Only show decorations in 'changes' mode
    if (config.mode !== 'changes') {
      return Decoration.none
    }

    const builder = new RangeSetBuilder<Decoration>()

    // Sort hunks by display position (required for RangeSetBuilder)
    const sortedHunks = [...config.hunks].sort((a, b) => a.displayFrom - b.displayFrom)

    // Process each hunk
    for (const hunk of sortedHunks) {
      // Skip hunks outside viewport for performance
      const { from: viewFrom, to: viewTo } = view.viewport
      if (hunk.displayTo < viewFrom || hunk.displayFrom > viewTo) {
        continue
      }

      // Add deletion widget (ghost text)
      const deletionDeco = createDeletionDecoration(hunk)
      if (deletionDeco) {
        // Widgets are point decorations (from === to)
        builder.add(deletionDeco.pos, deletionDeco.pos, deletionDeco.decoration)
      }

      // Add insertion mark
      const insertionDeco = createInsertionDecoration(hunk)
      if (insertionDeco) {
        builder.add(insertionDeco.from, insertionDeco.to, insertionDeco.decoration)
      }
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
 * Usage:
 * ```typescript
 * const extensions = [
 *   diffConfigFacet.of(config),
 *   diffViewPlugin,
 * ]
 * ```
 */
export const diffViewPlugin = ViewPlugin.fromClass(DiffViewPlugin, {
  decorations: (v) => v.decorations,
})

// ============================================================================
// EXTENSION BUNDLE
// ============================================================================

/**
 * Create the full diff view extension bundle.
 *
 * @param config - Initial configuration
 * @returns Extension array to add to the editor
 *
 * @example
 * ```typescript
 * const editor = new EditorView({
 *   extensions: [
 *     ...baseExtensions,
 *     createDiffViewExtension({
 *       mode: 'changes',
 *       baseline: content,
 *       aiVersion: aiVersion,
 *       hunks: computedHunks,
 *       onAcceptHunk: (id) => handleAccept(id),
 *       onRejectHunk: (id) => handleReject(id),
 *       onDualDocChange: (c, a) => handleDualChange(c, a),
 *     }),
 *   ],
 * })
 * ```
 */
export function createDiffViewExtension(config: DiffViewConfig): Extension {
  return [
    diffConfigFacet.of(config),
    diffViewPlugin,
    // Edit filter will be added in Phase 3
    // Keymap will be added in Phase 5
  ]
}
```

---

### Step 2.4: Update the index.ts export

Update `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
/**
 * Diff View Extension
 *
 * Provides word-level inline diff display for AI suggestions.
 * Shows deletions as red strikethrough (ghost widgets),
 * insertions as green underline (mark decorations).
 */

// Types
export * from './types'

// Plugin and extension
export {
  diffViewPlugin,
  diffConfigFacet,
  createDiffViewExtension,
} from './plugin'

// Widget (for testing/customization)
export { DeletionWidget } from './DeletionWidget'
```

---

### Step 2.5: Test the decorations

Create a quick test component or use the browser console:

```typescript
// In EditorPanel.tsx (temporary test code)
import { useWordDiff } from '@/features/documents/hooks/useWordDiff'
import { createDiffViewExtension } from '@/core/editor/codemirror/diffView'

// Inside the component:
const hunks = useWordDiff(content, aiVersion)

// Log to verify hunks are computed
useEffect(() => {
  console.log('Computed hunks:', hunks)
}, [hunks])

// Add extension to editor (temporary - proper wiring in Phase 6)
const diffExtension = useMemo(() => {
  if (!aiVersion) return []
  return createDiffViewExtension({
    mode: 'changes',
    baseline: content,
    aiVersion: aiVersion,
    hunks,
    onAcceptHunk: (id) => console.log('Accept:', id),
    onRejectHunk: (id) => console.log('Reject:', id),
    onDualDocChange: () => {},
  })
}, [content, aiVersion, hunks])
```

You should see:
- Red strikethrough text for deletions (appearing as ghost text)
- Green underlined text for insertions

---

## Verification Checklist

Before moving to Phase 3, verify:

- [ ] CSS classes added to `globals.css`
- [ ] `DeletionWidget.ts` created
- [ ] `plugin.ts` created with ViewPlugin
- [ ] `index.ts` updated with exports
- [ ] Test shows decorations rendering correctly
- [ ] Deleted text appears as red strikethrough ghost
- [ ] Inserted text appears with green underline

## Troubleshooting

**Decorations not showing?**
1. Check `mode` is set to `'changes'`
2. Verify `hunks` array is not empty
3. Check browser console for errors
4. Ensure CSS is loaded

**Wrong positions?**
1. Verify editor document is `aiVersion` (not `content`)
2. Check `displayFrom`/`displayTo` in hunks match aiVersion positions

**Widget not rendering?**
1. Check `DeletionWidget.toDOM()` returns valid DOM
2. Verify widget position is within document bounds

## Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/globals.css` | Modified (added diff styles) |
| `frontend/src/core/editor/codemirror/diffView/DeletionWidget.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/plugin.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Modified |

## Next Step

→ Continue to `03-edit-handling.md` to implement mode-aware editing
