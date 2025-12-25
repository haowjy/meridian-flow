# Phase 6: Integration

## Goal

Wire all pieces together in `EditorPanel.tsx` and ensure everything works end-to-end.

## What You're Building

The final integration where:
1. **On load**: Build merged document from `content` + `aiVersion`
2. **During editing**: Editor shows merged document with decorations + edit filter
3. **On save**: Parse merged document back to `content` + `aiVersion` (single request)
4. **Accept/reject**: CM6 transactions that modify the merged document (undoable!)

```
┌─────────────────────────────────────────────────────────────────┐
│                          LOAD                                    │
│  Storage (content + aiVersion) → buildMergedDocument() → Editor │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         EDITING                                  │
│  User types → CM6 transaction → Merged document updates         │
│  Accept/Reject → CM6 transaction → Merged document updates      │
│  Cmd+Z → CM6 undo → Merged document reverts                     │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          SAVE                                    │
│  Merged document → parseMergedDocument() → Storage              │
└─────────────────────────────────────────────────────────────────┘
```

## Key Architecture Points

### Merged Document is Source of Truth

The editor owns the merged document. React doesn't track `content` and `aiVersion` separately - we only extract them when saving.

### Accept/Reject are Undoable

Because accept/reject are CM6 transactions, pressing Cmd+Z after accepting a hunk **undoes the accept**. This is the killer feature of the PUA marker architecture.

### Simplified State

```typescript
// OLD: Complex dual-document tracking
const [localContent, setLocalContent] = useState('')
const [localAIVersion, setLocalAIVersion] = useState<string | null>(null)

// NEW: Single merged document
const [localDocument, setLocalDocument] = useState('')
```

### When to PATCH `ai_version` (important)

We do **not** want to keep sending `ai_version: null` forever after AI is closed.

Rule of thumb for autosave:
- If the editor document has markers (AI review active) → PATCH `ai_version` (string) + `ai_version_base_rev`.
- If the editor document has no markers but the last known server snapshot still has AI open (`activeDocument.aiVersion !== null`) → PATCH `ai_version: null` **once** to close it.
- Otherwise → omit `ai_version` entirely (content-only saves).

### Server Updates + “Dirty” Policy

We never mutate the merged document underneath active typing.

- **Dirty** = unsaved local edits in the *active* mode (`hasUserEdit === true`, debounce pending / in-flight).
- When a new server snapshot arrives (load/refresh/SSE/doc_edit):
  - If **not dirty**: refresh the merged document in place (no history; bypass filters).
  - If **dirty**: stash the incoming snapshot and show “Server updated — Refresh”.

### Concurrency: `ai_version_rev` (Required)

AI can update `aiVersion` asynchronously. To avoid overwriting a newer unseen `aiVersion`, any PATCH that includes `ai_version` must include `ai_version_base_rev` (the `ai_version_rev` the editor last hydrated from). If the server returns `409 Conflict` (rev mismatch), the UI must treat it like “server updated while dirty”:
- stash the latest server snapshot
- require explicit refresh before trying to apply further `ai_version` changes

### Refreshing Merged Doc (Cursor-Friendly)

Refreshing the merged doc means transforming `oldMerged → newMerged`.

- **Minimum viable:** full replace (no history). Cursor will clamp to a reasonable position.
- **Better:** compute an incremental patch (oldMerged → newMerged) and dispatch it as `changes` with `addToHistory: false`. CM6 maps the selection through the changes automatically, so the cursor usually stays “in place”.

**Minimal incremental diff → CM6 changes (sketch):**

```typescript
// Only run when NOT dirty.
// Apply with addToHistory:false and filter:false.
//
// This creates a ChangeSpec[] that transforms oldMerged into newMerged.
function diffToChanges(oldMerged: string, newMerged: string) {
  const dmp = new DiffMatchPatch()
  const diffs = dmp.diff_main(oldMerged, newMerged)
  dmp.diff_cleanupSemantic(diffs)
  dmp.diff_cleanupSemanticLossless(diffs)

  const changes: Array<{ from: number; to: number; insert: string }> = []
  let pos = 0

  for (const [op, text] of diffs) {
    if (op === 0) {
      pos += text.length
      continue
    }
    if (op === -1) {
      changes.push({ from: pos, to: pos + text.length, insert: '' })
      pos += text.length
      continue
    }
    if (op === 1) {
      changes.push({ from: pos, to: pos, insert: text })
      continue
    }
  }

  // IMPORTANT: apply in one dispatch; CM6 maps selection through it.
  return changes
}
```

## Steps

### Step 6.0: Update CodeMirrorEditorRef for history-safe hydration

Update `frontend/src/core/editor/codemirror/types.ts`:

```typescript
interface SetContentOptions {
  /** If false, don't add to undo history. Default: true */
  addToHistory?: boolean

  /**
   * If false, do not call the React `onChange` callback for this setContent().
   * Use this for hydration/refresh (server → editor), not for user actions.
   *
   * Default: true
   */
  emitChange?: boolean
}

// Update the existing EditorRef signature:
export interface EditorRef {
  getContent(): string
  setContent(content: string, options?: SetContentOptions): void
  focus(): void
  getView(): EditorView | null
}
```

Update `frontend/src/core/editor/codemirror/CodeMirrorEditor.tsx`:

```typescript
import { Transaction, Annotation } from '@codemirror/state'

// Module-scope annotation shared by setContent() + updateListener.
// When present, the React onChange callback is suppressed for that transaction.
const suppressOnChange = Annotation.define<boolean>()

// In the ref implementation:
setContent(content: string, options?: SetContentOptions) {
  if (!viewRef.current) return

  // Explicit hydration controls (don’t rely on ad-hoc caller flags)
  const addToHistory = options?.addToHistory !== false
  const emitChange = options?.emitChange !== false

  const annotations = [
    ...(addToHistory ? [] : [Transaction.addToHistory.of(false)]),
    ...(emitChange ? [] : [suppressOnChange.of(true)]),
  ]

  viewRef.current.dispatch({
    changes: { from: 0, to: viewRef.current.state.doc.length, insert: content },
    annotations: annotations.length > 0 ? annotations : undefined,
    // IMPORTANT: hydration/refresh replaces marker ranges; bypass diffEditFilter
    filter: addToHistory === false ? false : undefined,
  })
}
```

Also update the `onReady({ ... })` object’s `setContent` implementation to accept the same `options?: SetContentOptions` and apply the same annotations (there are two `setContent` implementations in this component today).

Update the update listener in `CodeMirrorEditor.tsx` to honor the annotation:

```typescript
// In initialize code (near updateListener):
const updateListener = EditorView.updateListener.of(update => {
  const shouldSuppress = update.transactions.some(tr => tr.annotation(suppressOnChange) === true)
  if (!shouldSuppress && update.docChanged && onChange) {
    onChange(update.state.doc.toString())
  }
})
```

---

### Step 6.1: Update EditorPanel.tsx

This is the main integration. The editor shows and owns the merged document.

```tsx
import { useCallback, useRef, useEffect, useMemo, useState } from 'react'
import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useEditorStore } from '@/core/stores/useEditorStore'
import { CodeMirrorEditor, type CodeMirrorEditorRef } from '@/core/editor/codemirror'
import {
  buildMergedDocument,
  extractHunks,
  type MergedHunk,
} from '@/features/documents/utils/mergedDocument'
import { documentSyncService } from '@/core/services/documentSyncService'
import {
  createDiffViewExtension,
  acceptAll,
  rejectAll,
  setFocusedHunkIndexEffect,
  type DiffKeymapCallbacks,
} from '@/core/editor/codemirror/diffView'
import { AIToolbar } from './AIToolbar'
import { AIHunkNavigator } from './AIHunkNavigator'

export function EditorPanel() {
  const editorRef = useRef<CodeMirrorEditorRef>(null)
  const diffEnabledRef = useRef(false)

  // Compartment for diff view extension (ref to persist across renders)
  // Using useRef instead of module scope for isolation in potential multi-editor scenarios
  const diffCompartmentRef = useRef<Compartment | null>(null)
  if (!diffCompartmentRef.current) {
    diffCompartmentRef.current = new Compartment()
  }
  const diffCompartment = diffCompartmentRef.current

  // Store state
  const activeDocument = useEditorStore((s) => s.activeDocument)
  const focusedHunkIndex = useEditorStore((s) => s.focusedHunkIndex)

  // Store actions
  const setFocusedHunkIndex = useEditorStore((s) => s.setFocusedHunkIndex)
  const navigateHunk = useEditorStore((s) => s.navigateHunk)

  // Local state: the merged document
  const [localDocument, setLocalDocument] = useState('')
  const [hasUserEdit, setHasUserEdit] = useState(false)
  const lastHydratedDocIdRef = useRef<string | null>(null)
  // Last ai_version_rev we hydrated from the server.
  // Used as ai_version_base_rev for compare-and-swap whenever we PATCH ai_version.
  const aiVersionBaseRevRef = useRef<number | null>(null)
  const saveTimerRef = useRef<number | null>(null)

  // Pending server snapshot (when updates arrive while dirty)
  const [pendingServerSnapshot, setPendingServerSnapshot] = useState<{
    content: string
    aiVersion: string | null | undefined
    aiVersionRev: number | null | undefined
  } | null>(null)

  // Computed hunks from the current document
  const hunks = useMemo(() => extractHunks(localDocument), [localDocument])

  // Derive hasAISuggestions from hunks (single source of truth)
  // No useState needed - this is computed from localDocument via hunks memo
  const hasAISuggestions = hunks.length > 0

  // ==========================================================================
  // INITIALIZATION: Build merged document from storage
  // ==========================================================================

  useEffect(() => {
    if (!activeDocument) return

    const docId = activeDocument.id
    const docChanged = lastHydratedDocIdRef.current !== docId

    if (!docChanged && hasUserEdit) {
      // Don't mutate the editor underneath the user. Stash and require explicit refresh.
      setPendingServerSnapshot({
        content: activeDocument.content ?? '',
        aiVersion: activeDocument.aiVersion,
        aiVersionRev: activeDocument.aiVersionRev,
      })
      return
    }

    if (!docChanged && pendingServerSnapshot) {
      // Server already updated while we were dirty; keep waiting for explicit refresh.
      return
    }

    if (docChanged || !hasUserEdit) {
      lastHydratedDocIdRef.current = docId
      setHasUserEdit(false)
      setPendingServerSnapshot(null)

      const content = activeDocument.content ?? ''
      const aiVersion = activeDocument.aiVersion
      const aiVersionRev = activeDocument.aiVersionRev

      if (aiVersion !== null && aiVersion !== undefined) {
        // Build merged document (hasAISuggestions derived from hunks.length)
        const merged = buildMergedDocument(content, aiVersion)
        setLocalDocument(merged)
        aiVersionBaseRevRef.current = aiVersionRev

        // Hydrate editor without adding to history
        if (editorRef.current) {
          editorRef.current.setContent(merged, { addToHistory: false, emitChange: false })
        }
      } else {
        // No AI version - just use content (hasAISuggestions will be false)
        setLocalDocument(content)
        // Still track ai_version_rev so we can safely PATCH ai_version if the user undoes
        // or otherwise re-introduces markers and we need to re-open AI.
        aiVersionBaseRevRef.current = aiVersionRev

        if (editorRef.current) {
          editorRef.current.setContent(content, { addToHistory: false, emitChange: false })
        }
      }
    }
  }, [activeDocument?.id, activeDocument?.content, activeDocument?.aiVersion, activeDocument?.aiVersionRev, hasUserEdit, pendingServerSnapshot])

  const handleRefreshFromServer = useCallback(() => {
    if (!pendingServerSnapshot) return
    if (!editorRef.current) return
    if (hasUserEdit) return

    const content = pendingServerSnapshot.content
    const aiVersion = pendingServerSnapshot.aiVersion
    const aiVersionRev = pendingServerSnapshot.aiVersionRev
    const merged =
      aiVersion !== null && aiVersion !== undefined
        ? buildMergedDocument(content, aiVersion)
        : content

    setLocalDocument(merged)
    setPendingServerSnapshot(null)
    aiVersionBaseRevRef.current = aiVersion !== null && aiVersion !== undefined ? aiVersionRev ?? null : null

    editorRef.current.setContent(merged, { addToHistory: false, emitChange: false })
  }, [hasUserEdit, pendingServerSnapshot])

  // ==========================================================================
  // COMPARTMENT-BASED DIFF VIEW MANAGEMENT
  // ==========================================================================

  const [isEditorReady, setIsEditorReady] = useState(false)

  // Navigation callbacks for keymap
  const keymapCallbacks: DiffKeymapCallbacks = useMemo(() => ({
    onNextHunk: () => navigateHunk('next', hunks.length),
    onPrevHunk: () => navigateHunk('prev', hunks.length),
  }), [navigateHunk, hunks.length])

  const handleEditorReady = useCallback((ref: CodeMirrorEditorRef) => {
    editorRef.current = ref
    setIsEditorReady(true)

    // Enable diff view if needed
    const view = ref.getView()
    if (!view) return

    const shouldEnable = hasAISuggestions
    if (shouldEnable) {
      view.dispatch({
        effects: diffCompartment.reconfigure(createDiffViewExtension(keymapCallbacks))
      })
      diffEnabledRef.current = true
    }
  }, [hasAISuggestions, keymapCallbacks])

  // Effect: Enable/disable diff extension
  useEffect(() => {
    if (!isEditorReady) return
    const view = editorRef.current?.getView()
    if (!view) return

    const shouldEnable = hasAISuggestions

    if (shouldEnable && !diffEnabledRef.current) {
      view.dispatch({
        effects: diffCompartment.reconfigure(createDiffViewExtension(keymapCallbacks))
      })
      diffEnabledRef.current = true
    } else if (!shouldEnable && diffEnabledRef.current) {
      view.dispatch({
        effects: diffCompartment.reconfigure([])
      })
      diffEnabledRef.current = false
    }
  }, [isEditorReady, hasAISuggestions, keymapCallbacks])

  // Initial extension array
  const initialExtensions = useMemo(() => [diffCompartment.of([])], [])

  // ==========================================================================
  // NAVIGATION
  // ==========================================================================

  // Scroll to focused hunk
  useEffect(() => {
    if (hunks.length === 0 || !editorRef.current) return

    const hunk = hunks[focusedHunkIndex]
    if (!hunk) return

    const view = editorRef.current.getView()
    if (!view) return

    // Keep CM6 “focused hunk” state in sync so:
    // - insertion region gets `.cm-ai-hunk-focused`
    // - focused hunk’s ✓/✕ actions are always visible
    view.dispatch({
      effects: setFocusedHunkIndexEffect.of(focusedHunkIndex),
    })

    // Use EditorView.scrollIntoView effect for proper CM6 scrolling
    // NOTE: EditorView is already imported from '@codemirror/view' at the top
    view.dispatch({
      selection: { anchor: hunk.from },
      effects: EditorView.scrollIntoView(hunk.from, { y: 'center' }),
    })
  }, [focusedHunkIndex, hunks])

  const handlePrevHunk = useCallback(() => {
    navigateHunk('prev', hunks.length)
  }, [navigateHunk, hunks.length])

  const handleNextHunk = useCallback(() => {
    navigateHunk('next', hunks.length)
  }, [navigateHunk, hunks.length])

  // ==========================================================================
  // BULK OPERATIONS (via CM6 transactions)
  // ==========================================================================

  const handleAcceptAll = useCallback(() => {
    const view = editorRef.current?.getView()
    if (!view) return

    acceptAll(view)
    setHasUserEdit(true)
    setFocusedHunkIndex(0)
  }, [setFocusedHunkIndex])

  const handleRejectAll = useCallback(() => {
    const view = editorRef.current?.getView()
    if (!view) return

    rejectAll(view)
    setHasUserEdit(true)
    setFocusedHunkIndex(0)
  }, [setFocusedHunkIndex])

  // ==========================================================================
  // CONTENT CHANGES
  // ==========================================================================

  const handleContentChange = useCallback((newContent: string) => {
    setLocalDocument(newContent)
    setHasUserEdit(true)
    // Note: hasAISuggestions is derived from hunks.length, which updates
    // automatically when localDocument changes via the useMemo above
  }, [])

  // ==========================================================================
  // DEBOUNCED SAVE
  // ==========================================================================

  useEffect(() => {
    if (!activeDocument) return
    if (!hasUserEdit) return

    // Don't attempt to PATCH ai_version if there's a pending conflict - user must refresh first
    if (pendingServerSnapshot) {
      return
    }

    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
    }

    // Capture document ID for closure to prevent race condition on document switch
    const saveDocumentId = activeDocument.id

    saveTimerRef.current = window.setTimeout(() => {
      const baseRev = aiVersionBaseRevRef.current

      // Decide whether this autosave should PATCH ai_version.
      // - Markers exist => AI review active => PATCH ai_version (string)
      // - No markers, but server still has AI open => PATCH ai_version:null once to close
      // - Otherwise => omit ai_version entirely (content-only)
      const hasMarkers = hunks.length > 0
      const serverHasAIVersion = activeDocument.aiVersion !== null && activeDocument.aiVersion !== undefined

      if (!hasMarkers && !serverHasAIVersion) {
        documentSyncService.save(saveDocumentId, localDocument, {
          onServerSaved: (doc) => {
            const currentDocId = useEditorStore.getState()._activeDocumentId
            if (currentDocId !== saveDocumentId) return
            useEditorStore.getState().updateActiveDocument(doc)
            setHasUserEdit(false)
          },
        })
        return
      }

      if (baseRev === null) {
        // Should be rare: we intend to PATCH ai_version but don't have a base rev.
        // Treat as “server updated while dirty”: require explicit refresh.
        setPendingServerSnapshot({
          content: activeDocument.content ?? '',
          aiVersion: activeDocument.aiVersion,
          aiVersionRev: activeDocument.aiVersionRev,
        })
        return
      }

      documentSyncService.saveMerged(saveDocumentId, localDocument, {
        aiVersionBaseRev: baseRev,
        serverHasAIVersion,
      }, {
        onServerSaved: (result) => {
          // Guard: Only update if still viewing the same document
          // This prevents updating wrong document state if user switched documents
          // while the save was in flight
          const currentDocId = useEditorStore.getState()._activeDocumentId
          if (currentDocId !== saveDocumentId) {
            // User switched documents - don't update state
            return
          }

          // Update store with server response
          useEditorStore.getState().updateActiveDocument(result.document)
          aiVersionBaseRevRef.current = result.document.aiVersionRev

          setHasUserEdit(false)
        },
        onAIVersionConflict: (serverDocument) => {
          // Server has a newer ai_version than this editor snapshot.
          // Stash snapshot and require explicit refresh before continuing.
          const latest = serverDocument ?? useEditorStore.getState().activeDocument
          if (!latest) return

          setPendingServerSnapshot({
            content: latest.content ?? '',
            aiVersion: latest.aiVersion,
            aiVersionRev: latest.aiVersionRev,
          })
        },
      })
    }, 1000)

    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    }
  }, [
    activeDocument?.id,
    activeDocument?.content,
    activeDocument?.aiVersion,
    activeDocument?.aiVersionRev,
    hasUserEdit,
    hunks.length,
    localDocument,
    pendingServerSnapshot,
  ])

  // ==========================================================================
  // EDITOR CONTENT
  // ==========================================================================

  // The editor is always editable; the CM6 transaction filter enforces read-only deletion regions.
  const isEditable = true

  // ==========================================================================
  // RENDER
  // ==========================================================================

  return (
    <div className="relative flex flex-col h-full">
      {/* AI Toolbar */}
      {hasAISuggestions && (
        <AIToolbar
          hunksCount={hunks.length}
          hasPendingServerUpdate={pendingServerSnapshot !== null}
          isDirty={hasUserEdit}
          onRefreshFromServer={handleRefreshFromServer}
        />
      )}

      {/* Editor container */}
      <div className="flex-1 relative overflow-hidden">
        {/* Main editor */}
        <CodeMirrorEditor
          initialContent={localDocument}
          editable={isEditable}
          extensions={initialExtensions}
          onChange={handleContentChange}
          onReady={handleEditorReady}
        />
      </div>

      {/* Floating navigator pill */}
      {hasAISuggestions && hunks.length > 0 && (
        <AIHunkNavigator
          hunks={hunks}
          currentIndex={focusedHunkIndex}
          onPrevious={handlePrevHunk}
          onNext={handleNextHunk}
          onAcceptAll={handleAcceptAll}
          onRejectAll={handleRejectAll}
        />
      )}
    </div>
  )
}
```

---

### Step 6.2: Update AIToolbar.tsx

```tsx
interface AIToolbarProps {
  hunksCount: number
  hasPendingServerUpdate?: boolean
  isDirty?: boolean
  onRefreshFromServer?: () => void
}

export function AIToolbar({
  hunksCount,
  hasPendingServerUpdate,
  isDirty,
  onRefreshFromServer,
}: AIToolbarProps) {
  return (
    <div className="flex items-center justify-between py-2 px-4 border-b bg-muted/30">
      <div className="text-sm text-muted-foreground">
        AI suggestions <span className="tabular-nums">({hunksCount})</span>
      </div>
      <div className="flex items-center gap-2">
        {hasPendingServerUpdate && (
          <button
            type="button"
            onClick={onRefreshFromServer}
            disabled={isDirty}
            className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
            title={isDirty ? 'Server updated — Save first to refresh' : 'Server updated — Refresh'}
          >
            Refresh
          </button>
        )}
      </div>
    </div>
  )
}
```

---

### Step 6.3: Update documentation

Add to `frontend/CLAUDE.md`:

```markdown
### AI Diff View

When `document.aiVersion` exists, the editor displays a merged document with PUA markers:

**Data Flow:**
- **Load**: `buildMergedDocument(content, aiVersion)` → editor
- **Edit**: User edits merged document directly
- **Save**: `parseMergedDocument()` → API (content + aiVersion)

**Key feature: Accept/reject are undoable!**
- Accept/reject dispatch CM6 transactions
- Cmd+Z undoes accept operations
- Full undo history preserved

**Key files:**
- `features/documents/utils/mergedDocument.ts` - Build/parse merged docs
- `core/editor/codemirror/diffView/` - Extension bundle
- `features/documents/components/AIHunkNavigator.tsx` - Navigation UI

**Keyboard shortcuts:**
- `Alt+N` / `Alt+P` - Navigate between changes
- `Cmd+Enter` - Accept hunk at cursor
- `Cmd+Shift+D` - Reject hunk at cursor
- `Cmd+Shift+Enter` - Accept all
- `Cmd+Shift+Backspace` - Reject all
- `Cmd+Z` - Undo (including undo accept/reject!)
```

---

## Testing Checklist

### Manual Test Cases

**Test 1: Basic diff display**
1. Load a document with `aiVersion`
2. ✅ Deletions show as red strikethrough
3. ✅ Insertions show as green underline
4. ✅ PUA markers are invisible

**Test 2: Accept single hunk**
1. Hover over a change
2. Click ✓ button
3. ✅ Hunk disappears (AI text replaces it)
4. ✅ Server receives update

**Test 3: Reject single hunk**
1. Hover over a change
2. Click ✕ button
3. ✅ Hunk disappears (original text replaces it)

**Test 4: Undo accept** (KEY TEST!)
1. Accept a hunk
2. Press Cmd+Z
3. ✅ Hunk reappears with diff styling
4. ✅ Document returns to previous state

**Test 5: Undo reject**
1. Reject a hunk
2. Press Cmd+Z
3. ✅ Hunk reappears with diff styling

**Test 6: Accept all**
1. Click "Accept All"
2. ✅ All changes applied
3. ✅ AI toolbar disappears
4. Press Cmd+Z
5. ✅ All changes reverted, toolbar reappears

**Test 7: Reject all**
1. Click "Reject All"
2. ✅ Original text restored
3. Press Cmd+Z
4. ✅ AI suggestions restored

**Test 8: Edit in green region**
1. Click inside green text
2. Type characters
3. ✅ Characters appear
4. ✅ Debounced save fires

**Test 9: Edit in red region**
1. Try to type in red strikethrough text
2. ✅ Edit blocked (no changes)

**Test 10: Keyboard navigation**
1. Press Alt+N → moves to next hunk
2. Press Alt+P → moves to previous hunk
3. Press Cmd+Enter → accepts hunk at cursor
4. Press Cmd+Shift+D → rejects hunk at cursor

**Test 11: Save after all resolved**
1. Accept or reject all hunks
2. Wait for debounced save
3. ✅ `aiVersion` is `null` in API response
4. ✅ AI toolbar disappears permanently

**Test 12: Server update while dirty**
1. Make a local edit (dirty = true)
2. Simulate a server snapshot change (AI updates `aiVersion`, doc refresh, etc.)
3. ✅ Editor content does not change under the cursor
4. ✅ “Refresh” appears (disabled while dirty)
5. Wait for save to complete (dirty = false)
6. Click “Refresh”
7. ✅ Merged doc updates without adding to undo history

---

## Next Phase

Finish with `07-cleanup-and-clipboard.md` to sanitize clipboard input/output and add save-time marker safety.

---

## Troubleshooting

### Decorations not showing
1. Verify document contains PUA markers (`\uE000`)
2. Check browser console for errors

### Accept/reject not working
1. Verify hunk ID exists in document
2. Check `extractHunks()` returns expected hunks
3. Add console logs in `transactions.ts`

### Undo not working
1. Ensure accept/reject use `view.dispatch()` (not React state)
2. Check no `addToHistory: false` on user actions
3. Verify CM6 history extension is enabled

### Edit filter not working
1. Check `diffEditFilter` is in extension array
2. Add console logs in `editFilter.ts`

---

## Files Modified in This Phase

| File | Action |
|------|--------|
| `frontend/src/core/editor/codemirror/types.ts` | Modified |
| `frontend/src/core/editor/codemirror/CodeMirrorEditor.tsx` | Modified |
| `frontend/src/features/documents/components/EditorPanel.tsx` | Major rewrite |
| `frontend/src/features/documents/components/AIToolbar.tsx` | Updated |
| `frontend/CLAUDE.md` | Updated |

---

## Summary

You've built a complete diff view system with:

1. **PUA marker-based merged documents** - Single source of truth
2. **Undoable accept/reject** - Cmd+Z works for ALL operations
3. **Inline decorations** - Red strikethrough, green underline
4. **Edit filtering** - Blocks edits in deletion regions
5. **Parse on save** - Clean markdown to storage
6. **Navigator UI** - Bulk actions and navigation
7. **Per-hunk actions** - Inline buttons
8. **Keyboard shortcuts** - Power user support

The implementation is simpler than the original two-document approach because:
- One document to track (merged)
- No dual-doc sync complexity
- CM6 owns the undo history
- React just renders what CM6 provides
