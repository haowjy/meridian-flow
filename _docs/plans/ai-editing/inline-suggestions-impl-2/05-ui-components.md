# Phase 5: UI Components

## Goal

Build the user-facing components:
1. **Navigator pill** - Change counter, prev/next, accept all/reject all
2. **Per-hunk action buttons** - Inline ✓/✕ buttons
3. **Keyboard shortcuts** - Quick accept/reject via keyboard

## Key Architecture Point

Accept/reject are **CM6 transactions**, not React state updates. This means:
- They modify the merged document directly
- They're automatically recorded in CM6 history
- **Cmd+Z undoes accept/reject operations!**

```typescript
// Accept = replace hunk region with insertion text
view.dispatch({
  changes: { from: hunk.from, to: hunk.to, insert: hunk.insertedText }
})

// Reject = replace hunk region with deletion text
view.dispatch({
  changes: { from: hunk.from, to: hunk.to, insert: hunk.deletedText }
})
```

## Steps

### Step 5.1: Create accept/reject transaction helpers

Create `frontend/src/core/editor/codemirror/diffView/transactions.ts`:

```typescript
/**
 * Accept/Reject Transaction Helpers
 *
 * These create CM6 transactions for hunk operations.
 * Since they're CM6 transactions, they're automatically undoable via Cmd+Z.
 */

import type { EditorView } from '@codemirror/view'
import { extractHunks, getAcceptReplacement, getRejectReplacement, acceptAllHunks, rejectAllHunks, type MergedHunk } from '@/features/documents/utils/mergedDocument'

/**
 * Accept a single hunk by ID.
 *
 * Replaces the entire hunk (markers + content) with the insertion text.
 * Returns true if the hunk was found and accepted.
 */
export function acceptHunk(view: EditorView, hunkId: string): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find(h => h.id === hunkId)

  if (!hunk) {
    console.warn(`Hunk not found: ${hunkId}`)
    return false
  }

  const replacement = getAcceptReplacement(hunk)

  view.dispatch({
    changes: { from: hunk.from, to: hunk.to, insert: replacement },
    // Bypass transaction filters (we intentionally delete/replace marker ranges)
    filter: false,
    userEvent: 'ai.diff.accept',
  })

  return true
}

/**
 * Reject a single hunk by ID.
 *
 * Replaces the entire hunk (markers + content) with the deletion text.
 * Returns true if the hunk was found and rejected.
 */
export function rejectHunk(view: EditorView, hunkId: string): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find(h => h.id === hunkId)

  if (!hunk) {
    console.warn(`Hunk not found: ${hunkId}`)
    return false
  }

  const replacement = getRejectReplacement(hunk)

  view.dispatch({
    changes: { from: hunk.from, to: hunk.to, insert: replacement },
    filter: false,
    userEvent: 'ai.diff.reject',
  })

  return true
}

/**
 * Accept the hunk at a given document position.
 *
 * Used for keyboard shortcut (accept hunk at cursor).
 */
export function acceptHunkAtPosition(view: EditorView, pos: number): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find(h => pos >= h.from && pos <= h.to)

  if (!hunk) return false

  return acceptHunk(view, hunk.id)
}

/**
 * Reject the hunk at a given document position.
 *
 * Used for keyboard shortcut (reject hunk at cursor).
 */
export function rejectHunkAtPosition(view: EditorView, pos: number): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find(h => pos >= h.from && pos <= h.to)

  if (!hunk) return false

  return rejectHunk(view, hunk.id)
}

/**
 * Accept all hunks.
 *
 * Replaces the entire document with the AI version.
 */
export function acceptAll(view: EditorView): void {
  const doc = view.state.doc.toString()
  const accepted = acceptAllHunks(doc)

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: accepted },
    filter: false,
    userEvent: 'ai.diff.acceptAll',
  })
}

/**
 * Reject all hunks.
 *
 * Replaces the entire document with the original version.
 */
export function rejectAll(view: EditorView): void {
  const doc = view.state.doc.toString()
  const rejected = rejectAllHunks(doc)

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: rejected },
    filter: false,
    userEvent: 'ai.diff.rejectAll',
  })
}

/**
 * Get hunks from the current document.
 *
 * Convenience function for UI components.
 */
export function getHunks(view: EditorView): MergedHunk[] {
  return extractHunks(view.state.doc.toString())
}
```

---

### Step 5.2: Create the keyboard shortcuts

Create `frontend/src/core/editor/codemirror/diffView/keymap.ts`:

```typescript
/**
 * Keyboard Shortcuts for Diff View
 *
 * Shortcuts:
 * - Alt+N: Navigate to next hunk
 * - Alt+P: Navigate to previous hunk
 * - Cmd/Ctrl+Enter: Accept hunk at cursor
 * - Cmd/Ctrl+Shift+D: Reject hunk at cursor (D for "delete/discard")
 * - Cmd/Ctrl+Shift+Enter: Accept all hunks
 * - Cmd/Ctrl+Shift+Backspace: Reject all hunks
 *
 * NOTE: We avoid Cmd+Backspace for single-hunk reject because it conflicts
 * with macOS "delete to beginning of line" shortcut.
 */

import { keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { acceptHunkAtPosition, rejectHunkAtPosition, acceptAll, rejectAll } from './transactions'

export interface DiffKeymapCallbacks {
  /** Navigate to next hunk (scroll + focus) */
  onNextHunk: () => void
  /** Navigate to previous hunk (scroll + focus) */
  onPrevHunk: () => void
}

/**
 * Create the diff view keymap extension.
 *
 * Accept/reject operations dispatch CM6 transactions directly.
 * Navigation uses external callbacks (needs to update React state).
 */
export function createDiffKeymap(callbacks: DiffKeymapCallbacks): Extension {
  return keymap.of([
    // Navigation (external callbacks)
    {
      key: 'Alt-n',
      run: () => {
        callbacks.onNextHunk()
        return true
      },
    },
    {
      key: 'Alt-p',
      run: () => {
        callbacks.onPrevHunk()
        return true
      },
    },

    // Single hunk operations (CM6 transactions)
    {
      key: 'Mod-Enter',
      run: (view) => {
        const pos = view.state.selection.main.head
        return acceptHunkAtPosition(view, pos)
      },
    },
    {
      // Cmd+Shift+D to reject (D for "delete/discard")
      // NOTE: Avoid Cmd+Backspace - conflicts with macOS "delete to beginning of line"
      key: 'Mod-Shift-d',
      run: (view) => {
        const pos = view.state.selection.main.head
        return rejectHunkAtPosition(view, pos)
      },
    },

    // Bulk operations (CM6 transactions)
    {
      key: 'Mod-Shift-Enter',
      run: (view) => {
        acceptAll(view)
        return true
      },
    },
    {
      key: 'Mod-Shift-Backspace',
      run: (view) => {
        rejectAll(view)
        return true
      },
    },
  ])
}
```

---

### Step 5.3: Create the HunkActionWidget

Create `frontend/src/core/editor/codemirror/diffView/HunkActionWidget.ts`:

```typescript
/**
 * Inline Accept/Reject Buttons for Hunks
 *
 * These buttons appear at the end of each insertion region.
 * Clicking them dispatches CM6 transactions (undoable!).
 */

import { WidgetType, type EditorView } from '@codemirror/view'
import { acceptHunk, rejectHunk } from './transactions'

/**
 * Widget that displays ✓/✕ buttons at the end of a hunk.
 */
export class HunkActionWidget extends WidgetType {
  constructor(
    private readonly hunkId: string,
    private readonly view: EditorView
  ) {
    super()
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span')
    container.className = 'cm-hunk-actions'
    container.dataset.hunkId = this.hunkId

    // Accept button
    const acceptBtn = document.createElement('button')
    acceptBtn.textContent = '✓'
    acceptBtn.className = 'cm-hunk-accept'
    acceptBtn.title = 'Accept this change (Cmd+Enter)'
    acceptBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      acceptHunk(this.view, this.hunkId)
    }

    // Reject button
    const rejectBtn = document.createElement('button')
    rejectBtn.textContent = '✕'
    rejectBtn.className = 'cm-hunk-reject'
    rejectBtn.title = 'Reject this change (Cmd+Shift+D)'
    rejectBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      rejectHunk(this.view, this.hunkId)
    }

    container.appendChild(acceptBtn)
    container.appendChild(rejectBtn)

    return container
  }

  eq(other: HunkActionWidget): boolean {
    return other.hunkId === this.hunkId
  }

  ignoreEvent(event: Event): boolean {
    // Allow click events to propagate to our buttons
    return event.type !== 'click'
  }
}
```

---

### Step 5.4: Update the plugin to include action widgets

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

Add import:
```typescript
import { HunkActionWidget } from './HunkActionWidget'
```

Update the `createHunkDecorations` function to add action widgets:

```typescript
/**
 * Create decorations for a single hunk.
 *
 * Includes:
 * 1. Hide all 4 PUA markers
 * 2. Style deletion content (red strikethrough)
 * 3. Style insertion content (green underline)
 * 4. Action widget at end of insertion
 */
function createHunkDecorations(
  hunk: MergedHunk,
  builder: RangeSetBuilder<Decoration>,
  view: EditorView
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
      hunk.delStart + 1,
      hunk.delEnd,
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
    hunk.delEnd + 1,
    hunk.delEnd + 2,
    Decoration.replace({ widget: markerWidget })
  )

  // 5. Style insertion content (if any)
  if (hunk.insertedText.length > 0) {
    builder.add(
      hunk.delEnd + 2,
      hunk.to - 1,
      Decoration.mark({ class: 'cm-ai-insertion' })
    )
  }

  // 6. Hide INS_END marker
  builder.add(
    hunk.to - 1,
    hunk.to,
    Decoration.replace({ widget: markerWidget })
  )

  // 7. Add action widget after the hunk
  builder.add(
    hunk.to,
    hunk.to,
    Decoration.widget({
      widget: new HunkActionWidget(hunk.id, view),
      side: 1,
    })
  )
}
```

Update `buildDecorations` to pass the view:

```typescript
buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)

  if (hunks.length === 0) {
    return Decoration.none
  }

  const builder = new RangeSetBuilder<Decoration>()

  for (const hunk of hunks) {
    const { from: viewFrom, to: viewTo } = view.viewport
    if (hunk.to < viewFrom || hunk.from > viewTo) {
      continue
    }

    createHunkDecorations(hunk, builder, view)  // Pass view
  }

  return builder.finish()
}
```

---

### Step 5.5: Create the AIHunkNavigator component

Create `frontend/src/features/documents/components/AIHunkNavigator.tsx`:

```tsx
import { ChevronUp, ChevronDown } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import type { MergedHunk } from '@/features/documents/utils/mergedDocument'

interface AIHunkNavigatorProps {
  /** All hunks in the document */
  hunks: MergedHunk[]
  /** Currently focused hunk index */
  currentIndex: number
  /** Navigate to previous hunk */
  onPrevious: () => void
  /** Navigate to next hunk */
  onNext: () => void
  /** Accept all changes (dispatches CM6 transaction) */
  onAcceptAll: () => void
  /** Reject all changes (dispatches CM6 transaction) */
  onRejectAll: () => void
}

/**
 * Floating navigation pill for diff hunks.
 *
 * Positioned at bottom-center of the editor.
 * Shows current change count and provides bulk actions.
 */
export function AIHunkNavigator({
  hunks,
  currentIndex,
  onPrevious,
  onNext,
  onAcceptAll,
  onRejectAll,
}: AIHunkNavigatorProps) {
  // Don't render if no hunks
  if (hunks.length === 0) return null

  // NOTE: Parent EditorPanel must have `position: relative` for this to work
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
      <div
        className="flex items-center gap-1 bg-background/95 backdrop-blur
                   border rounded-full px-2 py-1 shadow-lg pointer-events-auto"
      >
        {/* Navigation controls */}
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onPrevious}
          title="Previous change (Alt+P)"
        >
          <ChevronUp className="h-4 w-4" />
        </Button>

        {/* Change counter */}
        <span className="text-sm text-muted-foreground min-w-[5rem] text-center tabular-nums">
          Change {currentIndex + 1} / {hunks.length}
        </span>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onNext}
          title="Next change (Alt+N)"
        >
          <ChevronDown className="h-4 w-4" />
        </Button>

        {/* Separator */}
        <div className="w-px h-5 bg-border mx-1" />

        {/* Bulk actions */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs px-2"
          onClick={onRejectAll}
          title="Reject all changes (Cmd+Shift+Backspace)"
        >
          Reject All
        </Button>

        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs px-2"
          onClick={onAcceptAll}
          title="Accept all changes (Cmd+Shift+Enter)"
        >
          Accept All
        </Button>
      </div>
    </div>
  )
}
```

---

### Step 5.6: Update the extension bundle

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

```typescript
import { createDiffKeymap, type DiffKeymapCallbacks } from './keymap'

/**
 * Create the diff view extension bundle.
 *
 * @param keymapCallbacks - Navigation callbacks (optional)
 */
export function createDiffViewExtension(
  keymapCallbacks?: DiffKeymapCallbacks
): Extension {
  const extensions: Extension[] = [
    diffViewPlugin,
    diffEditFilter,
  ]

  if (keymapCallbacks) {
    extensions.push(createDiffKeymap(keymapCallbacks))
  }

  return extensions
}
```

---

### Step 5.7: Update the index.ts exports

Update `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 * - Blocks edits in deletion regions
 * - Accept/reject as CM6 transactions (undoable!)
 */

// Types
// Plugin and extension
export { diffViewPlugin, createDiffViewExtension } from './plugin'

// Edit filter
export { diffEditFilter } from './editFilter'

// Transactions (accept/reject)
export {
  acceptHunk,
  rejectHunk,
  acceptHunkAtPosition,
  rejectHunkAtPosition,
  acceptAll,
  rejectAll,
  getHunks,
} from './transactions'

// Keymap
export { createDiffKeymap, type DiffKeymapCallbacks } from './keymap'

// Widgets
export { HunkActionWidget } from './HunkActionWidget'
```

---

## CSS Styles (Added in Phase 2)

The CSS for hunk actions was added in Phase 2 (`globals.css`). Ensure these styles exist:

```css
.cm-hunk-actions {
  display: inline-flex;
  gap: 2px;
  margin-left: 4px;
  vertical-align: middle;
  opacity: 0;
  transition: opacity 150ms ease-in-out;
}

.cm-line:hover .cm-hunk-actions {
  opacity: 1;
}

.cm-hunk-actions:focus-within {
  opacity: 1;
}

.cm-hunk-accept {
  background: hsl(142.1 76.2% 36.3%);
  color: white;
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.cm-hunk-reject {
  background: var(--error);
  color: var(--error-foreground);
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}
```

---

## Component Preview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  The rain fell in sheets, drumming against the roof.                         │
│  S̶h̶e̶ ̶f̶e̶l̶t̶ ̶s̶a̶d̶.̶ A heavy melancholia settled in her chest. [✓][✕]         │
│                                                    └── Per-hunk actions      │
│  E̶v̶e̶r̶y̶t̶h̶i̶n̶g̶ ̶l̶o̶o̶k̶e̶d̶ ̶t̶h̶e̶ ̶s̶a̶m̶e̶.̶ The landscape remained unchanged. [✓][✕]    │
│                                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│              ┌─────────────────────────────────────────────────────┐         │
│              │  ↑  Change 1/2  ↓  │  Reject All   Accept All       │         │
│              └─────────────────────────────────────────────────────┘         │
│                          ↑ Navigator pill                                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Keyboard Shortcuts Summary

| Shortcut | Action |
|----------|--------|
| `Alt+N` | Navigate to next hunk |
| `Alt+P` | Navigate to previous hunk |
| `Cmd/Ctrl+Enter` | Accept hunk at cursor |
| `Cmd/Ctrl+Shift+D` | Reject hunk at cursor |
| `Cmd/Ctrl+Shift+Enter` | Accept all hunks |
| `Cmd/Ctrl+Shift+Backspace` | Reject all hunks |
| `Cmd/Ctrl+Z` | **Undo** (including undo accept/reject!) |

> **Note:** We use `Cmd+Shift+D` for single-hunk reject (D = delete/discard) instead of `Cmd+Backspace` because the latter conflicts with macOS "delete to beginning of line".

---

## Verification Checklist

Before moving to Phase 6, verify:

- [ ] `transactions.ts` created with accept/reject helpers
- [ ] `keymap.ts` created with keyboard shortcuts
- [ ] `HunkActionWidget.ts` created with inline buttons
- [ ] `AIHunkNavigator.tsx` component created
- [ ] Plugin updated to render action widgets
- [ ] Navigator shows correct change count
- [ ] Prev/Next navigation works
- [ ] Per-hunk ✓/✕ buttons appear on hover
- [ ] Keyboard shortcuts work
- [ ] **Cmd+Z undoes accept/reject operations!**

## Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/core/editor/codemirror/diffView/transactions.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/keymap.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/HunkActionWidget.ts` | Created |
| `frontend/src/features/documents/components/AIHunkNavigator.tsx` | Created |
| `frontend/src/core/editor/codemirror/diffView/plugin.ts` | Modified |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Modified |

## Next Step

---

## Focused Hunk Behavior (Required)

When the user navigates between hunks (via the navigator pill or keyboard shortcuts), the currently focused hunk should:
- get a visual highlight (`.cm-ai-hunk-focused`) on the insertion region
- always show its inline ✓/✕ actions (even without line hover)

### Step 5.8: Add focused hunk state to the CM6 extension

Create `frontend/src/core/editor/codemirror/diffView/focus.ts`:

```ts
import { StateEffect, StateField } from '@codemirror/state'

export const setFocusedHunkIndexEffect = StateEffect.define<number>()

export const focusedHunkIndexField = StateField.define<number>({
  create: () => 0,
  update: (value, tr) => {
    for (const e of tr.effects) {
      if (e.is(setFocusedHunkIndexEffect)) return e.value
    }
    return value
  },
})
```

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:
- Import `focusedHunkIndexField` and include it in `createDiffViewExtension()`
- In the ViewPlugin `update(...)`, rebuild decorations when a transaction includes `setFocusedHunkIndexEffect`
- In `buildDecorations(...)`, after `extractHunks(doc)`:
  - `const focusedIndex = view.state.field(focusedHunkIndexField)`
  - `const focused = hunks[focusedIndex]`
  - Add a `Decoration.mark({ class: 'cm-ai-hunk-focused' })` over the focused insertion range (e.g. `focused.insStart + 1` → `focused.insEnd`)

Update `frontend/src/core/editor/codemirror/diffView/HunkActionWidget.ts`:
- Add `focused: boolean` to the widget constructor
- In `toDOM()`, set `container.dataset.focused = focused ? 'true' : 'false'`

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts` where the widget is created:
- Pass `focused: index === focusedIndex` when creating `HunkActionWidget`

Update `frontend/src/core/editor/codemirror/diffView/index.ts` exports:
- Export `setFocusedHunkIndexEffect` so `EditorPanel` can keep CM6 in sync with the store focus state.


→ Continue to `06-integration.md` to wire everything together in EditorPanel.
