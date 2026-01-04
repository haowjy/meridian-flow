# Phase 5: Accept/Reject UI

**Dependencies**: Phase 4 (Live Diff Display)

---

## Overview

UI for accepting/rejecting AI suggestions shown as live diff hunks. Uses the diff computed from `diff(USER_EDITS, ai_version)`.

**Key Design**:
- Per-hunk Accept/Reject buttons (inline)
- Accept All / Reject All toolbar
- No Model B (no implicit accept) - explicit actions only
- Dismissed hunks tracked in session store (persists across document switches)

```
┌─────────────────────────────────────────────────────────────────────┐
│ 3 changes                                  [Accept All][Reject All] │
├─────────────────────────────────────────────────────────────────────┤
│  1  │ The story begins on a dark and stormy night.                  │
│  2  │ The ~~man walked~~ gentleman strode into the tavern. [K][U]   │
│  3  │ He ordered a drink.                                           │
│  4  │ "Give me your ~~strongest~~ finest ale," he said.    [K][U]   │
│  5  │ The ~~bartender~~ innkeeper nodded.                  [K][U]   │
└─────────────────────────────────────────────────────────────────────┘

Legend:
  ~~strikethrough~~ = user's current text (being replaced)
  highlighted = AI's suggested text
  [K][U] = Accept (apply AI) / Reject (keep user's)
```

---

## Files to Create

| File | Action |
|------|--------|
| `frontend/src/features/documents/components/AIToolbar.tsx` | Create |
| `frontend/src/features/documents/components/DiffHunk.tsx` | Create (from Phase 4) |
| `frontend/src/features/documents/stores/useAISessionStore.ts` | Modify (add dismissedHunks)

---

## Actions

| Action | Description | Backend Call |
|--------|-------------|--------------|
| **Accept (hunk)** | Replace user lines with AI lines in editor | None (local change) |
| **Reject (hunk)** | Dismiss hunk (hide from view) | None (local state) |
| **Accept All** | Replace entire doc with `ai_version` | `POST /ai-sessions/:id/resolve {status: accepted}` |
| **Reject All** | Clear all suggestions, keep user content | `POST /ai-sessions/:id/resolve {status: rejected}` |

**Key insight**:
- Accept: Modifies editor content → diff recomputes → hunk disappears
- Reject: Just hides the hunk (React state), user content unchanged

---

## AIToolbar Component

```typescript
interface AIToolbarProps {
  hunkCount: number
  onAcceptAll: () => void
  onRejectAll: () => void
}

export function AIToolbar({ hunkCount, onAcceptAll, onRejectAll }: AIToolbarProps) {
  if (hunkCount === 0) return null

  return (
    <div className="ai-toolbar">
      <span className="ai-toolbar-count">
        {hunkCount} change{hunkCount !== 1 ? 's' : ''}
      </span>
      <div className="ai-toolbar-actions">
        <Button size="sm" variant="default" onClick={onAcceptAll}>
          Accept All
        </Button>
        <Button size="sm" variant="ghost" onClick={onRejectAll}>
          Reject All
        </Button>
      </div>
    </div>
  )
}
```

---

## Accept/Reject Logic

### Accept Hunk (Apply AI Suggestion)

```typescript
function acceptHunk(view: EditorView, hunk: DiffHunk) {
  // Replace user's lines with AI's lines
  const startLine = view.state.doc.line(hunk.startLine)
  const endLine = view.state.doc.line(hunk.startLine + hunk.userLines.length - 1)

  view.dispatch({
    changes: {
      from: startLine.from,
      to: endLine.to,
      insert: hunk.aiLines.join('\n')
    }
  })
  // Diff recomputes automatically since USER_EDITS changed
  // Hunk disappears because user text now matches AI text
}
```

### Reject Hunk (Discard AI Suggestion)

```typescript
// Track dismissed hunks in Zustand store (persists across document switches)
function rejectHunk(sessionId: string, hunkId: string) {
  // Just hide this hunk - no document change
  useAISessionStore.getState().dismissHunk(sessionId, hunkId)
}

// Filter hunks for display
const dismissedHunks = useAISessionStore(state => state.getDismissedHunks(session?.id))
const visibleHunks = hunks.filter(h => !dismissedHunks.has(h.id))
```

### Accept All (Accept All Suggestions)

```typescript
async function acceptAll(view: EditorView, aiVersion: string, sessionId: string) {
  // Replace entire document with ai_version
  view.dispatch({
    changes: {
      from: 0,
      to: view.state.doc.length,
      insert: aiVersion
    }
  })

  // Resolve session on backend
  await api.aiSessions.resolve(sessionId, 'accepted')
}
```

### Reject All (Reject All Suggestions)

```typescript
async function rejectAll(sessionId: string) {
  // No document changes - just clear the session
  // User keeps their current content
  await api.aiSessions.resolve(sessionId, 'rejected')
}
```

---

## Integration with Editor

```typescript
function EditorWithAISuggestions({ documentId }: Props) {
  const { session, aiVersion } = useAISession(documentId)
  const [editorContent, setEditorContent] = useState('')
  const viewRef = useRef<EditorView | null>(null)

  // Compute diff hunks live
  const { hunks, visibleHunks, dismissHunk, resetDismissed } = useAIDiff(
    editorContent,
    session?.status === 'active' ? aiVersion : null
  )

  const handleAcceptHunk = (hunk: DiffHunk) => {
    if (!viewRef.current) return
    acceptHunk(viewRef.current, hunk)
    // Diff will recompute, hunk will disappear
  }

  const handleRejectHunk = (hunkId: string) => {
    dismissHunk(hunkId)
  }

  const handleAcceptAll = async () => {
    if (!viewRef.current || !aiVersion || !session) return
    await acceptAll(viewRef.current, aiVersion, session.id)
  }

  const handleRejectAll = async () => {
    if (!session) return
    await rejectAll(session.id)
    resetDismissed() // Clear dismissed set for next session
  }

  return (
    <div>
      <AIToolbar
        hunkCount={visibleHunks.length}
        onAcceptAll={handleAcceptAll}
        onRejectAll={handleRejectAll}
      />
      <CodeMirrorEditor
        value={editorContent}
        onChange={setEditorContent}
        hunks={visibleHunks}
        onAcceptHunk={handleAcceptHunk}
        onRejectHunk={handleRejectHunk}
        ref={viewRef}
      />
    </div>
  )
}
```

---

## UI States

### Active Session with Suggestions
```
┌─────────────────────────────────────────────────────────────────────┐
│ 3 changes                                  [Accept All][Reject All] │
├─────────────────────────────────────────────────────────────────────┤
│  The ~~man walked~~ gentleman strode into the tavern. [Accept][Reject] │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### No Active Session
```
┌─────────────────────────────────────────────────────────────────────┐
│                       (no toolbar shown)                            │
├─────────────────────────────────────────────────────────────────────┤
│  The man walked into the tavern.                                    │
│  ...                                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### Action Results
```
Accept (hunk):
  Before: "The ~~man walked~~ gentleman strode into the tavern. [K][U]"
  After:  "The gentleman strode into the tavern."  (no diff, hunk gone)

Reject (hunk):
  Before: "The ~~man walked~~ gentleman strode into the tavern. [K][U]"
  After:  "The man walked into the tavern."  (hunk dismissed, hidden)

Accept All:
  USER_EDITS = ai_version
  All hunks disappear (no diff)
  Session status = 'accepted'

Reject All:
  USER_EDITS unchanged
  Session status = 'rejected'
  All hunks hidden
```

---

## What Changed from Original Design

| Original | New |
|----------|-----|
| TipTap marks with `original` attr | Live diff hunks |
| Model B: edit inside = accept | **Removed** - explicit only |
| SuggestionPopover hover UI | Inline Accept/Reject buttons |
| Mark-based restore | No restore needed (user text unchanged) |

---

## Dismissed Hunks Persistence

Store dismissed hunks in Zustand session store, not component state. This ensures:
- Dismissed hunks persist across document switches
- State is cleaned up when session closes

```typescript
// In useAISessionStore (Zustand)
interface AISessionState {
  // ... existing session state
  dismissedHunks: Map<string, Set<string>>  // sessionId → hunkIds

  dismissHunk: (sessionId: string, hunkId: string) => void
  getDismissedHunks: (sessionId: string) => Set<string>
  clearDismissed: (sessionId: string) => void
}

export const useAISessionStore = create<AISessionState>((set, get) => ({
  dismissedHunks: new Map(),

  dismissHunk: (sessionId, hunkId) => {
    set(state => {
      const newMap = new Map(state.dismissedHunks)
      const existing = newMap.get(sessionId) ?? new Set()
      newMap.set(sessionId, new Set([...existing, hunkId]))
      return { dismissedHunks: newMap }
    })
  },

  getDismissedHunks: (sessionId) => {
    return get().dismissedHunks.get(sessionId) ?? new Set()
  },

  clearDismissed: (sessionId) => {
    set(state => {
      const newMap = new Map(state.dismissedHunks)
      newMap.delete(sessionId)
      return { dismissedHunks: newMap }
    })
  },
}))

// Usage in component
const dismissedHunks = useAISessionStore(
  state => state.getDismissedHunks(session?.id)
)

const handleUndoHunk = (hunkId: string) => {
  if (session) {
    useAISessionStore.getState().dismissHunk(session.id, hunkId)
  }
}
```

---

## Stale Suggestion Warning

When user edits diverge significantly from AI suggestions, show a warning:

```typescript
interface AIToolbarProps {
  hunkCount: number
  totalHunkChars: number  // Sum of all userText + aiText lengths
  documentLength: number
  onAcceptAll: () => void
  onRejectAll: () => void
}

export function AIToolbar({
  hunkCount,
  totalHunkChars,
  documentLength,
  onAcceptAll,
  onRejectAll
}: AIToolbarProps) {
  if (hunkCount === 0) return null

  // Show warning if >50% of document is affected by diffs
  const divergenceRatio = totalHunkChars / Math.max(documentLength, 1)
  const isStale = divergenceRatio > 0.5

  return (
    <div className="ai-toolbar">
      <span className="ai-toolbar-count">
        {hunkCount} change{hunkCount !== 1 ? 's' : ''}
      </span>

      {isStale && (
        <span className="ai-warning">
          ⚠️ These suggestions may be outdated due to your edits
        </span>
      )}

      <div className="ai-toolbar-actions">
        <Button size="sm" variant="default" onClick={onAcceptAll}>
          Accept All
        </Button>
        <Button size="sm" variant="ghost" onClick={onRejectAll}>
          Reject All
        </Button>
      </div>
    </div>
  )
}
```

CSS:
```css
.ai-warning {
  font-size: 12px;
  color: var(--warning);
  display: flex;
  align-items: center;
  gap: 4px;
}
```

---

## Success Criteria

- [ ] Toolbar shows hunk count
- [ ] Accept All replaces doc with ai_version, resolves session
- [ ] Reject All resolves session, keeps user content
- [ ] Per-hunk Accept button replaces user lines with AI lines
- [ ] Per-hunk Reject button dismisses hunk (hides from view)
- [ ] Dismissed hunks don't reappear during session
- [ ] Dismissed hunks persist across document switches
- [ ] User can edit freely while suggestions are pending
- [ ] No implicit accept behavior (explicit Accept/Reject only)
- [ ] Stale suggestion warning shown when >50% divergence
