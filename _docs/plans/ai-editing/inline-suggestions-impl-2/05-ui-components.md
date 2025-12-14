# Phase 5: UI Components

## Goal
Build the user-facing components:
1. Floating navigator pill (change counter, prev/next, accept all/reject all)
2. Per-hunk action widget (✓/✕ buttons)
3. Keyboard shortcuts

## Steps

### Step 5.1: Create the AIHunkNavigator component

Create `frontend/src/features/documents/components/AIHunkNavigator.tsx`:

```tsx
import { ChevronUp, ChevronDown } from 'lucide-react'
import { Button } from '@/shared/components/ui/button'
import type { WordDiffHunk } from '@/core/editor/codemirror/diffView/types'

interface AIHunkNavigatorProps {
  /** All computed hunks */
  hunks: WordDiffHunk[]
  /** Currently focused hunk index */
  currentIndex: number
  /** Navigate to previous hunk */
  onPrevious: () => void
  /** Navigate to next hunk */
  onNext: () => void
  /** Accept all changes */
  onAcceptAll: () => void
  /** Reject all changes */
  onRejectAll: () => void
  /** Whether an operation is in progress */
  isLoading?: boolean
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
  isLoading = false,
}: AIHunkNavigatorProps) {
  // Don't render if no hunks
  if (hunks.length === 0) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
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
          disabled={isLoading}
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
          disabled={isLoading}
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
          disabled={isLoading}
          title="Reject all changes (Cmd+Shift+Backspace)"
        >
          Reject All
        </Button>

        <Button
          size="sm"
          variant="default"
          className="h-7 text-xs px-2"
          onClick={onAcceptAll}
          disabled={isLoading}
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

### Step 5.2: Create the HunkActionWidget

Create `frontend/src/core/editor/codemirror/diffView/HunkActionWidget.ts`:

```typescript
import { WidgetType } from '@codemirror/view'

/**
 * Widget that displays accept/reject buttons for a hunk.
 *
 * These buttons appear at the end of each hunk's inserted text.
 */
export class HunkActionWidget extends WidgetType {
  constructor(
    private readonly hunkId: string,
    private readonly onAccept: (id: string) => void,
    private readonly onReject: (id: string) => void
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
      this.onAccept(this.hunkId)
    }

    // Reject button
    const rejectBtn = document.createElement('button')
    rejectBtn.textContent = '✕'
    rejectBtn.className = 'cm-hunk-reject'
    rejectBtn.title = 'Reject this change (Cmd+Backspace)'
    rejectBtn.onclick = (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.onReject(this.hunkId)
    }

    container.appendChild(acceptBtn)
    container.appendChild(rejectBtn)

    return container
  }

  eq(other: HunkActionWidget): boolean {
    return other.hunkId === this.hunkId
  }

  ignoreEvent(event: Event): boolean {
    // Allow click events to propagate to buttons
    return event.type !== 'click'
  }
}
```

---

### Step 5.3: Update the plugin to include hunk action widgets

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

Add the import:
```typescript
import { HunkActionWidget } from './HunkActionWidget'
```

Add a new decoration builder function:
```typescript
/**
 * Create a widget decoration for hunk action buttons.
 */
function createHunkActionDecoration(
  hunk: WordDiffHunk,
  onAccept: (id: string) => void,
  onReject: (id: string) => void
): { pos: number; decoration: Decoration } | null {
  // Only show actions for hunks with insertions
  if (!hunk.insertedText) return null

  return {
    pos: hunk.displayTo,
    decoration: Decoration.widget({
      widget: new HunkActionWidget(hunk.id, onAccept, onReject),
      side: 1, // After the insertion
    }),
  }
}
```

Update the `buildDecorations` method in `DiffViewPlugin`:
```typescript
buildDecorations(view: EditorView): DecorationSet {
  const config = view.state.facet(diffConfigFacet)

  if (config.mode !== 'changes') {
    return Decoration.none
  }

  const builder = new RangeSetBuilder<Decoration>()
  const sortedHunks = [...config.hunks].sort((a, b) => a.displayFrom - b.displayFrom)

  for (const hunk of sortedHunks) {
    const { from: viewFrom, to: viewTo } = view.viewport
    if (hunk.displayTo < viewFrom || hunk.displayFrom > viewTo) {
      continue
    }

    // Add deletion widget
    const deletionDeco = createDeletionDecoration(hunk)
    if (deletionDeco) {
      builder.add(deletionDeco.pos, deletionDeco.pos, deletionDeco.decoration)
    }

    // Add insertion mark
    const insertionDeco = createInsertionDecoration(hunk)
    if (insertionDeco) {
      builder.add(insertionDeco.from, insertionDeco.to, insertionDeco.decoration)
    }

    // Add hunk action buttons (after insertion)
    const actionDeco = createHunkActionDecoration(
      hunk,
      config.onAcceptHunk,
      config.onRejectHunk
    )
    if (actionDeco) {
      builder.add(actionDeco.pos, actionDeco.pos, actionDeco.decoration)
    }
  }

  return builder.finish()
}
```

---

### Step 5.4: Create the keyboard shortcuts

Create `frontend/src/core/editor/codemirror/diffView/keymap.ts`:

```typescript
import { keymap } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { diffConfigFacet } from './plugin'

/**
 * Create keyboard shortcuts for diff navigation and actions.
 *
 * Shortcuts:
 * - Alt+N: Next hunk
 * - Alt+P: Previous hunk
 * - Cmd/Ctrl+Enter: Accept current hunk
 * - Cmd/Ctrl+Backspace: Reject current hunk
 * - Cmd/Ctrl+Shift+Enter: Accept all hunks
 * - Cmd/Ctrl+Shift+Backspace: Reject all hunks
 *
 * @param callbacks - External callbacks for actions
 */
export function createDiffKeymap(callbacks: {
  onNextHunk: () => void
  onPrevHunk: () => void
  onAcceptCurrent: () => void
  onRejectCurrent: () => void
  onAcceptAll: () => void
  onRejectAll: () => void
}): Extension {
  return keymap.of([
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
    {
      key: 'Mod-Enter',
      run: () => {
        callbacks.onAcceptCurrent()
        return true
      },
    },
    {
      key: 'Mod-Backspace',
      run: () => {
        callbacks.onRejectCurrent()
        return true
      },
    },
    {
      key: 'Mod-Shift-Enter',
      run: () => {
        callbacks.onAcceptAll()
        return true
      },
    },
    {
      key: 'Mod-Shift-Backspace',
      run: () => {
        callbacks.onRejectAll()
        return true
      },
    },
  ])
}
```

---

### Step 5.5: Update the extension bundle to include keymap

Update `frontend/src/core/editor/codemirror/diffView/plugin.ts`:

Add import:
```typescript
import { createDiffKeymap } from './keymap'
```

Update `createDiffViewExtension`:
```typescript
/**
 * Create the full diff view extension bundle.
 *
 * @param config - Configuration including callbacks
 * @param keymapCallbacks - Keyboard shortcut callbacks (optional)
 */
export function createDiffViewExtension(
  config: DiffViewConfig,
  keymapCallbacks?: {
    onNextHunk: () => void
    onPrevHunk: () => void
    onAcceptCurrent: () => void
    onRejectCurrent: () => void
    onAcceptAll: () => void
    onRejectAll: () => void
  }
): Extension {
  const extensions: Extension[] = [
    diffConfigFacet.of(config),
    diffViewPlugin,
    diffEditFilter,
  ]

  // Add keymap if callbacks provided
  if (keymapCallbacks) {
    extensions.push(createDiffKeymap(keymapCallbacks))
  }

  return extensions
}
```

---

### Step 5.6: Update the index.ts exports

Update `frontend/src/core/editor/codemirror/diffView/index.ts`:

```typescript
/**
 * Diff View Extension
 *
 * Provides word-level inline diff display for AI suggestions.
 */

// Types
export * from './types'

// Plugin and extension
export {
  diffViewPlugin,
  diffConfigFacet,
  createDiffViewExtension,
} from './plugin'

// Position mapping utilities
export {
  buildOffsetTable,
  aiPosToContentPos,
  contentPosToAiPos,
  getPositionRegion,
  applyDualEdit,
} from './positionMapping'

// Edit filter
export { diffEditFilter } from './editFilter'

// Keymap
export { createDiffKeymap } from './keymap'

// Widgets
export { DeletionWidget } from './DeletionWidget'
export { HunkActionWidget } from './HunkActionWidget'
```

---

### Step 5.7: Add hover effect for hunk actions

Update `frontend/src/globals.css` to show actions only on hover:

```css
/**
 * Hunk action buttons - show on hover
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

/* Show when focused within */
.cm-hunk-actions:focus-within {
  opacity: 1;
}

/* Always show for focused hunk */
.cm-ai-hunk-focused .cm-hunk-actions {
  opacity: 1;
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

## Verification Checklist

Before moving to Phase 6, verify:

- [ ] `AIHunkNavigator.tsx` component created
- [ ] `HunkActionWidget.ts` widget created
- [ ] `keymap.ts` created with keyboard shortcuts
- [ ] Plugin updated to render action widgets
- [ ] CSS updated for hover effects
- [ ] Navigator shows correct change count
- [ ] Prev/Next navigation works
- [ ] Accept/Reject All buttons work
- [ ] Per-hunk ✓/✕ buttons appear on hover
- [ ] Keyboard shortcuts work (Alt+N/P, Cmd+Enter, etc.)

## Files Created/Modified

| File | Action |
|------|--------|
| `frontend/src/features/documents/components/AIHunkNavigator.tsx` | Created |
| `frontend/src/core/editor/codemirror/diffView/HunkActionWidget.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/keymap.ts` | Created |
| `frontend/src/core/editor/codemirror/diffView/plugin.ts` | Modified |
| `frontend/src/core/editor/codemirror/diffView/index.ts` | Modified |
| `frontend/src/globals.css` | Modified |

## Next Step

→ Continue to `06-integration.md` to wire everything together
