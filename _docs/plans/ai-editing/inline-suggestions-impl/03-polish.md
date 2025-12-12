# Phase 3: Polish

Add keyboard shortcuts, navigation, and styling refinements.

---

## Step 9: Add Keyboard Shortcuts

**Goal:** Keyboard navigation and accept/reject for power users.

**Files:**
- `frontend/src/features/documents/editor/mergeExtensions.ts`

**Changes:**

```ts
import { keymap } from '@codemirror/view'
import {
  acceptChunk,
  rejectChunk,
  goToNextChunk,
  goToPreviousChunk,
} from '@codemirror/merge'

/**
 * Keyboard shortcuts for merge view operations.
 */
export const mergeKeymap = keymap.of([
  { key: 'Mod-Enter', run: acceptChunk },      // Accept chunk at cursor
  { key: 'Mod-Backspace', run: rejectChunk },  // Reject chunk at cursor
  { key: 'Alt-n', run: goToNextChunk },        // Navigate to next chunk
  { key: 'Alt-p', run: goToPreviousChunk },    // Navigate to previous chunk
])

/**
 * Extensions for Changes mode - unified diff view with keyboard shortcuts.
 */
export function changesExtensions(baseline: string): Extension[] {
  return [
    ...baseMarkdownExtensions,
    mergeKeymap,  // Add keyboard shortcuts
    unifiedMergeView({
      original: baseline,
      highlightChanges: true,
      mergeControls: true,
      gutter: true,
      syntaxHighlightDeletions: true,
    }),
  ]
}
```

**Keyboard Shortcuts Reference:**

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl + Enter` | Accept chunk at cursor |
| `Cmd/Ctrl + Backspace` | Reject chunk at cursor |
| `Alt + N` | Go to next chunk |
| `Alt + P` | Go to previous chunk |

**Verification:**
- [ ] `Alt+N` / `Alt+P` navigate between chunks
- [ ] `Cmd+Enter` accepts the current chunk
- [ ] `Cmd+Backspace` rejects the current chunk
- [ ] Shortcuts only work in Changes mode (not AI Draft)

---

## Step 10: Add Floating Hunk Navigator

**Goal:** Bottom-center pill for chunk navigation (like Cursor/VS Code).

**Files:**
- `frontend/src/features/documents/components/AIHunkNavigator.tsx` (new)
- `frontend/src/features/documents/components/EditorPanel.tsx`

**AIHunkNavigator.tsx:**

```tsx
import { useCallback, useEffect, useState } from 'react'
import { EditorView } from '@codemirror/view'
import { getChunks, goToNextChunk, goToPreviousChunk } from '@codemirror/merge'
import { Button } from '@/shared/components/ui/button'
import { ChevronUp, ChevronDown } from 'lucide-react'

interface AIHunkNavigatorProps {
  editorView: EditorView | null
}

/**
 * Floating pill for navigating between diff chunks.
 * Shows chunk count and prev/next buttons.
 */
export function AIHunkNavigator({ editorView }: AIHunkNavigatorProps) {
  const [chunkCount, setChunkCount] = useState(0)

  useEffect(() => {
    if (!editorView) {
      setChunkCount(0)
      return
    }

    const update = () => {
      const info = getChunks(editorView.state)
      setChunkCount(info?.chunks.length ?? 0)
    }

    update() // initial
    // TODO: later, attach a proper updateListener extension to drive this reactively
  }, [editorView])

  const handlePrevious = useCallback(() => {
    if (editorView) goToPreviousChunk(editorView)
  }, [editorView])

  const handleNext = useCallback(() => {
    if (editorView) goToNextChunk(editorView)
  }, [editorView])

  // Don't show if no chunks or no editor
  if (!editorView || chunkCount === 0) return null

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
      <div className="flex items-center gap-1 bg-background/95 backdrop-blur border rounded-full px-2 py-1 shadow-lg">
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handlePrevious}
          className="size-6 rounded-full"
          title="Previous change (Alt+P)"
        >
          <ChevronUp className="size-4" />
        </Button>

        <span className="text-xs text-muted-foreground px-2 min-w-[80px] text-center">
          {chunkCount} change{chunkCount !== 1 ? 's' : ''}
        </span>

        <Button
          size="icon-sm"
          variant="ghost"
          onClick={handleNext}
          className="size-6 rounded-full"
          title="Next change (Alt+N)"
        >
          <ChevronDown className="size-4" />
        </Button>
      </div>
    </div>
  )
}
```

**EditorPanel.tsx changes:**

```tsx
import { AIHunkNavigator } from './AIHunkNavigator'

// In render, add navigator (only in Changes mode):
<div className="relative flex-1">
  {/* ... existing overlay and editor ... */}

  {/* Floating navigator - only show in Changes mode */}
  {hasAISuggestions && aiEditorMode === 'changes' && (
    <AIHunkNavigator editorView={mergeEditorRef.current?.getView() ?? null} />
  )}
</div>
```

**Verification:**
- [ ] Navigator pill appears at bottom-center when in Changes mode
- [ ] Shows correct chunk count
- [ ] Up/Down buttons navigate between chunks
- [ ] Hidden in AI Draft and Original modes
- [ ] Hidden when no chunks

---

## Step 11: Styling & Polish

**Goal:** Visual refinement for diff view.

**Files:**
- `frontend/src/globals.css`

**Changes:**

```css
/* ==========================================================================
   Merge View Styling
   ========================================================================== */

/* Changed line background */
.cm-mergeView .cm-changedLine {
  background: rgba(16, 185, 129, 0.08); /* emerald tint */
}

/* Deleted chunk background */
.cm-mergeView .cm-deletedChunk {
  background: rgba(239, 68, 68, 0.08); /* red tint */
}

/* Deleted text styling */
.cm-mergeView del {
  color: var(--muted-foreground);
  text-decoration: line-through;
  opacity: 0.7;
}

/* Inserted text styling */
.cm-mergeView ins {
  background: rgba(16, 185, 129, 0.15);
  text-decoration: none;
  border-radius: 2px;
  padding: 0 2px;
}

/* Gutter markers */
.cm-mergeView .cm-changeGutter {
  width: 4px;
}

.cm-mergeView .cm-changeGutter .cm-gutterElement {
  background: var(--emerald-500);
}

/* Dark mode adjustments */
.dark .cm-mergeView .cm-changedLine {
  background: rgba(16, 185, 129, 0.12);
}

.dark .cm-mergeView .cm-deletedChunk {
  background: rgba(239, 68, 68, 0.12);
}

.dark .cm-mergeView ins {
  background: rgba(16, 185, 129, 0.25);
}

/* Merge controls (accept/reject buttons per chunk) */
.cm-mergeView .cm-mergeControlGutter button {
  opacity: 0.6;
  transition: opacity 0.15s;
}

.cm-mergeView .cm-mergeControlGutter button:hover {
  opacity: 1;
}

/* Bottom spacer for navigator pill */
.ai-editor-container .cm-scroller {
  padding-bottom: 80px; /* Space for floating navigator */
}
```

**Additional Polish:**

1. **Auto-hide navigator when scrolled to bottom**
2. **Fade animation on navigator**
3. **Keyboard shortcut hints on hover**

**Verification:**
- [ ] Diff colors look good in light mode
- [ ] Diff colors look good in dark mode
- [ ] Deleted text is clearly struck through
- [ ] Inserted text has subtle highlight
- [ ] Gutter shows change markers
- [ ] Navigator doesn't cover content

---

## Polish Complete Checklist

After completing Steps 9-11:

- [ ] Keyboard shortcuts work (Cmd+Enter, Alt+N, etc.)
- [ ] Navigator pill shows and works
- [ ] Styling is polished in both light/dark modes
- [ ] Per-chunk accept/reject buttons visible (from mergeControls)
- [ ] Everything feels cohesive with rest of UI

**Next:** Proceed to `04-cleanup.md`
