# Phase 6: Integration

## Goal
Wire all the pieces together in `EditorPanel.tsx` and ensure everything works end-to-end.

## Steps

### Step 6.1: Update EditorPanel.tsx

This is the main integration point. Update `frontend/src/features/documents/components/EditorPanel.tsx`:

```tsx
import { useCallback, useMemo, useRef, useEffect } from 'react'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { CodeMirrorEditor, type CodeMirrorEditorRef } from '@/core/editor/codemirror'
import { useWordDiff } from '@/features/documents/hooks/useWordDiff'
import {
  createDiffViewExtension,
  type DiffViewConfig,
} from '@/core/editor/codemirror/diffView'
import { AIToolbar } from './AIToolbar'
import { AIHunkNavigator } from './AIHunkNavigator'
import { OriginalOverlay } from './OriginalOverlay'

export function EditorPanel() {
  const editorRef = useRef<CodeMirrorEditorRef>(null)

  // Store state
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const aiEditorMode = useEditorStore((s) => s.aiEditorMode)
  const isHunkOpInProgress = useEditorStore((s) => s.isHunkOpInProgress)
  const focusedHunkIndex = useEditorStore((s) => s.focusedHunkIndex)

  // Store actions
  const acceptHunk = useEditorStore((s) => s.acceptHunk)
  const rejectHunk = useEditorStore((s) => s.rejectHunk)
  const acceptAllHunks = useEditorStore((s) => s.acceptAllHunks)
  const rejectAllHunks = useEditorStore((s) => s.rejectAllHunks)
  const updateBothDocuments = useEditorStore((s) => s.updateBothDocuments)
  const navigateHunk = useEditorStore((s) => s.navigateHunk)

  // Derived state
  const content = activeDocument?.content ?? ''
  const aiVersion = activeDocument?.aiVersion
  const hasAISuggestions = !!aiVersion

  // Compute hunks
  const hunks = useWordDiff(content, aiVersion)

  // Find hunk by ID
  const findHunkById = useCallback(
    (id: string) => hunks.find((h) => h.id === id),
    [hunks]
  )

  // Handle accept hunk (from widget or keyboard)
  const handleAcceptHunk = useCallback(
    (hunkId: string) => {
      const hunk = findHunkById(hunkId)
      if (hunk) {
        acceptHunk(hunk)
      }
    },
    [findHunkById, acceptHunk]
  )

  // Handle reject hunk (from widget or keyboard)
  const handleRejectHunk = useCallback(
    (hunkId: string) => {
      const hunk = findHunkById(hunkId)
      if (hunk) {
        rejectHunk(hunk)
      }
    },
    [findHunkById, rejectHunk]
  )

  // Handle dual-document change (from edit filter)
  const handleDualDocChange = useCallback(
    (newContent: string, newAiVersion: string) => {
      updateBothDocuments(newContent, newAiVersion)
    },
    [updateBothDocuments]
  )

  // Handle accept/reject current (focused) hunk
  const handleAcceptCurrent = useCallback(() => {
    const currentHunk = hunks[focusedHunkIndex]
    if (currentHunk) {
      acceptHunk(currentHunk)
    }
  }, [hunks, focusedHunkIndex, acceptHunk])

  const handleRejectCurrent = useCallback(() => {
    const currentHunk = hunks[focusedHunkIndex]
    if (currentHunk) {
      rejectHunk(currentHunk)
    }
  }, [hunks, focusedHunkIndex, rejectHunk])

  // Navigation handlers
  const handlePrevHunk = useCallback(() => {
    navigateHunk('prev', hunks.length)
  }, [navigateHunk, hunks.length])

  const handleNextHunk = useCallback(() => {
    navigateHunk('next', hunks.length)
  }, [navigateHunk, hunks.length])

  // Create diff view extension
  const diffExtension = useMemo(() => {
    if (!hasAISuggestions || aiEditorMode === 'original') {
      return []
    }

    const config: DiffViewConfig = {
      mode: aiEditorMode,
      baseline: content,
      aiVersion: aiVersion!,
      hunks,
      onAcceptHunk: handleAcceptHunk,
      onRejectHunk: handleRejectHunk,
      onDualDocChange: handleDualDocChange,
    }

    return createDiffViewExtension(config, {
      onNextHunk: handleNextHunk,
      onPrevHunk: handlePrevHunk,
      onAcceptCurrent: handleAcceptCurrent,
      onRejectCurrent: handleRejectCurrent,
      onAcceptAll: acceptAllHunks,
      onRejectAll: rejectAllHunks,
    })
  }, [
    hasAISuggestions,
    aiEditorMode,
    content,
    aiVersion,
    hunks,
    handleAcceptHunk,
    handleRejectHunk,
    handleDualDocChange,
    handleNextHunk,
    handlePrevHunk,
    handleAcceptCurrent,
    handleRejectCurrent,
    acceptAllHunks,
    rejectAllHunks,
  ])

  // Scroll to focused hunk when it changes
  useEffect(() => {
    if (hunks.length === 0 || !editorRef.current) return

    const hunk = hunks[focusedHunkIndex]
    if (!hunk) return

    const view = editorRef.current.getView()
    if (!view) return

    // Scroll the hunk into view
    view.dispatch({
      effects: [
        // EditorView.scrollIntoView would be ideal here
        // For now, we can use selection to move viewport
      ],
      selection: { anchor: hunk.displayFrom },
      scrollIntoView: true,
    })
  }, [focusedHunkIndex, hunks])

  // Determine what content to show in the editor
  const editorContent = useMemo(() => {
    if (!hasAISuggestions) {
      return content
    }

    // In all AI modes, the editor shows aiVersion
    // (Original mode uses OriginalOverlay instead)
    return aiVersion!
  }, [hasAISuggestions, content, aiVersion])

  // Determine if editor is editable
  const isEditable = useMemo(() => {
    if (!hasAISuggestions) return true
    if (aiEditorMode === 'original') return true // OriginalOverlay handles this
    return true // Changes and AI Draft are editable
  }, [hasAISuggestions, aiEditorMode])

  return (
    <div className="relative flex flex-col h-full">
      {/* AI Toolbar (mode switcher) */}
      {hasAISuggestions && (
        <AIToolbar hunksCount={hunks.length} />
      )}

      {/* Editor container */}
      <div className="flex-1 relative overflow-hidden">
        {/* Main editor */}
        <CodeMirrorEditor
          ref={editorRef}
          initialContent={editorContent}
          editable={isEditable}
          extraExtensions={diffExtension}
          onChange={handleContentChange}
          // ... other props
        />

        {/* Original overlay (shown in Original mode) */}
        {hasAISuggestions && aiEditorMode === 'original' && (
          <OriginalOverlay content={content} />
        )}
      </div>

      {/* Floating navigator pill */}
      {hasAISuggestions && aiEditorMode === 'changes' && (
        <AIHunkNavigator
          hunks={hunks}
          currentIndex={focusedHunkIndex}
          onPrevious={handlePrevHunk}
          onNext={handleNextHunk}
          onAcceptAll={acceptAllHunks}
          onRejectAll={rejectAllHunks}
          isLoading={isHunkOpInProgress}
        />
      )}
    </div>
  )
}
```

---

### Step 6.2: Update AIToolbar.tsx

Update `frontend/src/features/documents/components/AIToolbar.tsx`:

```tsx
import { useEditorStore } from '@/core/stores/useEditorStore'

interface AIToolbarProps {
  hunksCount: number
}

export function AIToolbar({ hunksCount }: AIToolbarProps) {
  const aiEditorMode = useEditorStore((s) => s.aiEditorMode)
  const setAIEditorMode = useEditorStore((s) => s.setAIEditorMode)

  const modes = [
    { id: 'original', label: 'Original' },
    { id: 'changes', label: 'Changes' },
    { id: 'aiDraft', label: 'AI Draft' },
  ] as const

  return (
    <div className="flex items-center justify-center py-2 px-4 border-b bg-muted/30">
      <div className="inline-flex rounded-lg border bg-background p-0.5">
        {modes.map((mode) => (
          <button
            key={mode.id}
            onClick={() => setAIEditorMode(mode.id)}
            className={`
              px-3 py-1 text-sm rounded-md transition-colors
              ${aiEditorMode === mode.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
              }
            `}
          >
            {mode.label}
            {mode.id === 'changes' && hunksCount > 0 && (
              <span className="ml-1.5 text-xs opacity-70">
                ({hunksCount})
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
```

---

### Step 6.3: Update OriginalOverlay.tsx

Update `frontend/src/features/documents/components/OriginalOverlay.tsx`:

```tsx
import { CodeMirrorEditor } from '@/core/editor/codemirror'

interface OriginalOverlayProps {
  content: string
}

/**
 * Read-only overlay showing the original content.
 *
 * Rendered on top of the main editor when in "Original" mode.
 * The main editor stays mounted underneath to preserve state.
 */
export function OriginalOverlay({ content }: OriginalOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 bg-background">
      <CodeMirrorEditor
        initialContent={content}
        editable={false}
        // No extra extensions needed for read-only view
      />
    </div>
  )
}
```

---

### Step 6.4: Delete the old useAIDiff hook

Now that we have `useWordDiff`, remove the old implementation:

```bash
rm frontend/src/features/documents/hooks/useAIDiff.ts
```

Update any imports that referenced `useAIDiff` to use `useWordDiff` instead.

---

### Step 6.5: Update documentation

Update `frontend/CLAUDE.md` to document the new diff view:

Add to the CodeMirror Editor section:

```markdown
### AI Diff View

When `document.aiVersion` exists, the editor shows a word-level diff:

**Modes:**
- **Original**: Read-only view of baseline content (overlay)
- **Changes**: Inline diff with red deletions, green insertions
- **AI Draft**: Plain view of AI version (editable)

**Key files:**
- `core/editor/codemirror/diffView/` - Extension bundle
- `features/documents/hooks/useWordDiff.ts` - Diff computation
- `features/documents/components/AIHunkNavigator.tsx` - Navigation UI

**Keyboard shortcuts (in Changes mode):**
- `Alt+N` / `Alt+P` - Navigate between changes
- `Cmd+Enter` - Accept current change
- `Cmd+Backspace` - Reject current change
- `Cmd+Shift+Enter` - Accept all
- `Cmd+Shift+Backspace` - Reject all
```

---

## Testing Checklist

### Manual Test Cases

**Test 1: Basic diff display**
1. Load a document with `aiVersion`
2. Switch to Changes mode
3. ✅ Verify: Deletions show as red strikethrough
4. ✅ Verify: Insertions show as green underline
5. ✅ Verify: Unchanged text renders normally

**Test 2: Mode switching**
1. Click "Original" tab
2. ✅ Verify: Shows baseline content, read-only
3. Click "AI Draft" tab
4. ✅ Verify: Shows AI version, editable, no diff styling
5. Click "Changes" tab
6. ✅ Verify: Returns to diff view

**Test 3: Accept single hunk**
1. In Changes mode, hover over a change
2. Click ✓ button
3. ✅ Verify: Change is applied to content
4. ✅ Verify: Hunk disappears from diff view
5. ✅ Verify: Server receives update

**Test 4: Reject single hunk**
1. In Changes mode, hover over a change
2. Click ✕ button
3. ✅ Verify: Original text is restored in aiVersion
4. ✅ Verify: Hunk disappears from diff view

**Test 5: Accept all**
1. Click "Accept All" in navigator pill
2. ✅ Verify: All changes applied
3. ✅ Verify: aiVersion cleared
4. ✅ Verify: Toolbar disappears

**Test 6: Reject all**
1. Click "Reject All" in navigator pill
2. ✅ Verify: aiVersion cleared
3. ✅ Verify: Content unchanged
4. ✅ Verify: Toolbar disappears

**Test 7: Keyboard navigation**
1. Press `Alt+N` repeatedly
2. ✅ Verify: Focus moves to each hunk
3. Press `Alt+P`
4. ✅ Verify: Focus moves backwards

**Test 8: Keyboard accept/reject**
1. Navigate to a hunk
2. Press `Cmd+Enter`
3. ✅ Verify: Hunk accepted
4. Navigate to another hunk
5. Press `Cmd+Backspace`
6. ✅ Verify: Hunk rejected

**Test 9: Edit in green region**
1. Click inside green (inserted) text
2. Type some characters
3. ✅ Verify: Characters appear
4. ✅ Verify: Only aiVersion updated

**Test 10: Edit in red region (should be blocked)**
1. Try to click inside red (deleted) text
2. Try to type
3. ✅ Verify: No changes happen

**Test 11: Edit outside hunks**
1. Click in unchanged text area
2. Type some characters
3. ✅ Verify: Characters appear
4. ✅ Verify: Both content AND aiVersion updated

**Test 12: Race condition - rapid operations**
1. Click Accept All
2. Immediately click Reject All (while first is processing)
3. ✅ Verify: Second operation blocked (isHunkOpInProgress)
4. ✅ Verify: No duplicate API calls

**Test 13: Document switching during operation**
1. Start an accept operation
2. Quickly switch to another document
3. ✅ Verify: Operation doesn't affect new document

---

## Troubleshooting

### Decorations not showing
1. Check `aiEditorMode` is `'changes'`
2. Verify `hunks` array is populated
3. Check browser console for errors
4. Ensure CSS is loaded

### Accept/Reject not working
1. Check `isHunkOpInProgress` isn't stuck true
2. Verify hunk ID matches
3. Check network tab for API errors
4. Verify store callbacks are wired correctly

### Edit filter not working
1. Check diffEditFilter is in extension array
2. Verify config facet is updating
3. Add console logs in editFilter.ts

### Position mapping errors
1. Log offset table contents
2. Verify hunk positions are correct
3. Check for off-by-one errors

---

## Files Modified in This Phase

| File | Action |
|------|--------|
| `frontend/src/features/documents/components/EditorPanel.tsx` | Major update |
| `frontend/src/features/documents/components/AIToolbar.tsx` | Updated |
| `frontend/src/features/documents/components/OriginalOverlay.tsx` | Updated |
| `frontend/src/features/documents/hooks/useAIDiff.ts` | Deleted |
| `frontend/CLAUDE.md` | Updated |

---

## Final Checklist

Before considering the feature complete:

- [ ] All 13 test cases pass
- [ ] No console errors
- [ ] TypeScript compiles without errors
- [ ] ESLint passes (`pnpm run lint`)
- [ ] Documentation updated
- [ ] Old code removed (useAIDiff.ts)

---

## Summary

You've built a complete custom diff view system with:

1. **Word-level diffing** using jsdiff
2. **Inline decorations** (strikethrough + underline)
3. **Mode-aware editing** (blocks red, allows green, syncs outside)
4. **Atomic sync operations** with race protection
5. **Navigator UI** with bulk actions
6. **Per-hunk actions** on hover
7. **Keyboard shortcuts** for power users

The implementation follows SOLID principles and integrates cleanly with the existing codebase architecture.
