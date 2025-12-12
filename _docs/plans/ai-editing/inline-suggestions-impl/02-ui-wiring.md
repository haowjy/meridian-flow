# Phase 2: UI & Wiring

Connect the foundation to the UI. After this phase, the merge view is functional.

---

## Step 5: Add Mode Switcher UI to AIToolbar

**Goal:** Add mode buttons to toolbar (wired to store, but editor doesn't respond yet).

**Files:**
- `frontend/src/features/documents/components/AIToolbar.tsx`

**Changes:**

```tsx
import { useEditorStore, type AIEditorMode } from '@/core/stores/useEditorStore'
import { cn } from '@/shared/lib/utils'

// Mode configuration
const modes: { value: AIEditorMode; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'changes', label: 'Changes' },
  { value: 'aiDraft', label: 'AI Draft' },
]

interface AIToolbarProps {
  hunkCount: number
  onAcceptAll: () => void
  onRejectAll: () => void
  isLoading?: boolean
}

export function AIToolbar({ hunkCount, onAcceptAll, onRejectAll, isLoading }: AIToolbarProps) {
  const aiEditorMode = useEditorStore((s) => s.aiEditorMode)
  const setAIEditorMode = useEditorStore((s) => s.setAIEditorMode)

  if (hunkCount === 0) return null

  return (
    <div className="ai-toolbar flex items-center justify-between px-3 py-2 bg-emerald-50 dark:bg-emerald-950/30 border-b border-emerald-200 dark:border-emerald-800/50">
      {/* Mode Switcher */}
      <div className="flex gap-1 bg-muted rounded-md p-0.5">
        {modes.map((m) => (
          <button
            key={m.value}
            onClick={() => setAIEditorMode(m.value)}
            className={cn(
              "px-2 py-1 text-xs rounded transition-colors",
              aiEditorMode === m.value
                ? "bg-background shadow-sm font-medium"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Change count + Actions */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-emerald-700 dark:text-emerald-300">
          {hunkCount} change{hunkCount !== 1 ? 's' : ''}
        </span>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="default"
            onClick={onAcceptAll}
            disabled={isLoading}
            className="bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            <Check className="size-3.5" />
            Accept All
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onRejectAll}
            disabled={isLoading}
          >
            <Undo2 className="size-3.5" />
            Reject All
          </Button>
        </div>
      </div>
    </div>
  )
}
```

**Verification:**
- [ ] Mode buttons appear in toolbar when AI suggestions exist
- [ ] Clicking buttons changes store state (check React DevTools)
- [ ] Editor doesn't respond yet (expected)

---

## Step 6: Wire Merge View to EditorPanel (Changes Mode Only)

**Goal:** Replace plain editor with merge view when `aiVersion` exists.

**Files:**
- `frontend/src/features/documents/components/EditorPanel.tsx`

**Changes:**

This is the most significant change. Key modifications:

1. **Import new hook and extensions**
2. **Conditionally render merge view vs plain editor**
3. **Keep existing Accept All / Reject All working**

```tsx
// New imports
import { useMergeEditor } from '../hooks/useMergeEditor'

// Inside EditorPanel component:

// Determine if we have AI suggestions
const hasAISuggestions = !!activeDocument?.aiVersion
const baseline = activeDocument?.content ?? ''
const draft = activeDocument?.aiVersion ?? baseline

// Use merge editor hook (only active when AI suggestions exist)
const { editorRef: mergeEditorRef, initialExtensions } = useMergeEditor(baseline)

// ... existing code ...

// In render:
{isContentLoading ? (
  <div className="p-8 space-y-4">
    <Skeleton className="h-6 w-3/4" />
    {/* ... */}
  </div>
) : hasAISuggestions ? (
  // Merge editor for AI suggestions
  <EditorContextMenu editorRef={mergeEditorRef.current}>
    <div className="relative pt-1 flex-1 ai-editor-container">
      <CodeMirrorEditor
        initialContent={draft}
        editable={isEditable}
        placeholder="Start writing..."
        onChange={handleDraftChange}
        onReady={(ref) => { mergeEditorRef.current = ref }}
        extensions={[initialExtensions]}
        className="min-h-full"
      />
    </div>
  </EditorContextMenu>
) : (
  // Normal editor (no AI suggestions)
  <EditorContextMenu editorRef={editorRef.current}>
    <div className="relative pt-1 flex-1">
      <CodeMirrorEditor
        initialContent={localContent}
        editable={isEditable}
        placeholder="Start writing..."
        onChange={handleChange}
        onReady={handleReady}
        className="min-h-full"
      />
    </div>
  </EditorContextMenu>
)}
```

**Note:** May need to update `CodeMirrorEditor` to accept an `extensions` prop if it doesn't already.

**Verification:**
- [ ] Without `aiVersion`: normal editor works as before
- [ ] With `aiVersion`: merge view shows diff (deletions struck through, additions highlighted)
- [ ] Accept All / Reject All still work
- [ ] Mode switcher doesn't affect editor yet (expected)

---

## Step 7: Wire Mode Switching (Changes ↔ AI Draft)

**Goal:** Mode switcher actually changes the editor view.

**Files:**
- `frontend/src/features/documents/components/EditorPanel.tsx`

**Changes:**

```tsx
// Get mode from store
const aiEditorMode = useEditorStore((s) => s.aiEditorMode)

// Get switchMode from hook
const { editorRef: mergeEditorRef, switchMode, initialExtensions } = useMergeEditor(baseline)

// React to mode changes
useEffect(() => {
  // Only switch for modes that use the merge editor
  // 'original' mode is handled separately (overlay)
  if (hasAISuggestions && aiEditorMode !== 'original') {
    switchMode(aiEditorMode)
  }
}, [hasAISuggestions, aiEditorMode, switchMode])
```

**Verification:**
- [ ] Switching Changes → AI Draft hides diff markers, shows plain text
- [ ] Switching AI Draft → Changes shows diff markers again
- [ ] **Undo history is preserved** across switches (type something, switch modes, Cmd+Z should still work)
- [ ] Original mode does nothing yet (expected)

---

## Step 8: Implement Original Mode (Overlay)

**Goal:** Original mode shows read-only baseline as overlay.

**Files:**
- `frontend/src/features/documents/components/OriginalOverlay.tsx` (new)
- `frontend/src/features/documents/components/EditorPanel.tsx`

**OriginalOverlay.tsx:**

```tsx
import { CodeMirrorEditor } from '@/core/editor/codemirror'

interface OriginalOverlayProps {
  content: string
}

/**
 * Read-only overlay showing the original content.
 * Displayed over the main editor when in "Original" mode.
 * The main editor remains mounted underneath to preserve state.
 */
export function OriginalOverlay({ content }: OriginalOverlayProps) {
  return (
    <div className="absolute inset-0 z-10 bg-background overflow-auto">
      <div className="relative pt-1 flex-1">
        <CodeMirrorEditor
          initialContent={content}
          editable={false}
          className="min-h-full"
        />
      </div>
    </div>
  )
}
```

**EditorPanel.tsx changes:**

```tsx
import { OriginalOverlay } from './OriginalOverlay'

// In render, add overlay:
<div className="relative flex-1">
  {/* Original mode overlay - keeps main editor mounted underneath */}
  {aiEditorMode === 'original' && hasAISuggestions && (
    <OriginalOverlay content={baseline} />
  )}

  {/* Main editor (normal or merge) */}
  {isContentLoading ? (
    // ... skeleton
  ) : hasAISuggestions ? (
    // ... merge editor
  ) : (
    // ... normal editor
  )}
</div>
```

**Verification:**
- [ ] Original mode shows baseline content (read-only)
- [ ] Cannot edit in Original mode
- [ ] Switching back to Changes/AI Draft returns to merge editor
- [ ] **Undo history preserved** when switching away from and back to Changes/AI Draft

---

## UI Wiring Complete Checklist

After completing Steps 5-8:

- [ ] Mode switcher appears in AIToolbar
- [ ] Changes mode shows unified diff
- [ ] AI Draft mode shows plain editor (no diff markers)
- [ ] Original mode shows read-only overlay
- [ ] Undo history preserved across Changes ↔ AI Draft switches
- [ ] Accept All / Reject All still work
- [ ] Normal editing (no aiVersion) unaffected

**Next:** Proceed to `03-polish.md`
