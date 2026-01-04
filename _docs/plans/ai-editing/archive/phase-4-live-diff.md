# Phase 4: Live Diff with Inline Display

**Dependencies**: Phase 0 (CodeMirror Migration), Phase 3 (Session API)

---

## Overview

Display AI suggestions as inline word-level diffs (Google Docs style). Computed live from `diff(USER_EDITS, ai_version)`. No complex position tracking needed.

**Key Architecture**:
- `ai_version` stored in session (backend computes after each edit)
- Frontend computes `diffLines(USER_EDITS, ai_version)` on-the-fly
- Word-level diff shown inline: ~~old~~ new
- Multi-line changes grouped with single Accept/Reject

```
Before:
"The man walked into the tavern."

With AI suggestion:
"The ~~man walked~~ gentleman strode into the tavern."
     └─ strikethrough ─┘ └─ green highlight ──────────┘
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `frontend/src/features/documents/hooks/useAIDiff.ts` | Create | Live diff computation (pure string diff) |
| `frontend/src/features/documents/components/DiffHunk.tsx` | Create | Inline word-diff display |
| `frontend/src/features/documents/components/AIToolbar.tsx` | Create | Accept All / Reject All buttons |
| `frontend/src/features/documents/components/EditorWithAISuggestions.tsx` | Create | Orchestrates `CodeMirrorEditor` + diff via `CodeMirrorEditorRef` |
| `frontend/src/globals.css` | Modify | Inline diff styles |

---

## Dependencies

```bash
pnpm add diff-match-patch
pnpm add -D @types/diff-match-patch
```

---

## Why diff-match-patch (Not diff)

For prose/creative writing, we need a **semantic diff** library, not a code diff library.

| Library | Focus | Semantic Cleanup | Best For |
|---------|-------|------------------|----------|
| `diff` | Code | No | Line/word diffs for source code |
| `diff-match-patch` | Text | Yes | Prose, documents, natural language |

**Key Benefits**:
1. **Semantic cleanup** - `diff_cleanupSemantic()` merges small edits into meaningful chunks
2. **Character-level with smart boundaries** - doesn't split words awkwardly
3. **Whitespace aware** - handles newline variations gracefully
4. **Timeout control** - won't hang on large documents (configurable)

**Example - why it matters**:
```
User adds newlines around AI's edit:

With `diff` library:
  Hunk 1: [empty line added]
  Hunk 2: "man walked" → "gentleman strode"
  Hunk 3: [empty line added]

With `diff-match-patch` + semantic cleanup:
  Hunk 1: "man walked" → "gentleman strode"
  (whitespace changes merged or ignored)
```

---

## Performance Considerations

### Large Document Handling

For documents over 20k words, diff computation may take 100-500ms. Mitigations:

| Doc Size | Expected Performance | Mitigation |
|----------|---------------------|------------|
| 5k words (~25KB) | < 10ms | None needed |
| 20k words (~100KB) | < 50ms | None needed |
| 50k words (~250KB) | 100-500ms | Debounce + loading state |
| 100k+ words | May hit timeout | Fallback UI |

**1. Debounced diff computation** - Add 150ms debounce for large docs:

```typescript
const debouncedUserEdits = useDebouncedValue(
  userEdits,
  userEdits.length > 100000 ? 150 : 0  // Debounce for 100KB+
)

const hunks = useMemo(() => {
  if (!aiVersion) return []
  return computeDiffHunks(debouncedUserEdits, aiVersion)
}, [debouncedUserEdits, aiVersion])
```

**2. Loading state** - Show indicator while diff computes:

```typescript
const [isComputing, setIsComputing] = useState(false)

useEffect(() => {
  if (!aiVersion) return
  setIsComputing(true)
  startTransition(() => {
    setIsComputing(false)
  })
}, [userEdits, aiVersion])

// In AIToolbar
{isComputing && <span className="ai-computing">Computing diff...</span>}
```

**3. Timeout fallback** - If diff hits 1s timeout:

```typescript
function computeDiffHunks(userEdits: string, aiVersion: string): DiffHunk[] {
  const diffs = dmp.diff_main(userEdits, aiVersion)
  dmp.diff_cleanupSemantic(diffs)

  // Check if timeout occurred (empty diff but content differs)
  if (diffs.length === 0 && userEdits !== aiVersion) {
    return [{
      id: 'timeout',
      startPos: 0,
      userText: '(diff unavailable for large document)',
      aiText: '(click Accept All to apply AI version)',
    }]
  }

  // ... rest of computation
}
```

---

## Visual Design

```
┌─────────────────────────────────────────────────────────────────────┐
│ 3 changes                                    [Accept All][Reject All] │
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

## Core Implementation

### useAIDiff Hook

```typescript
import { useMemo, useState } from 'react'
import DiffMatchPatch from 'diff-match-patch'

// Diff operation types from diff-match-patch
const DIFF_DELETE = -1
const DIFF_INSERT = 1
const DIFF_EQUAL = 0

export interface DiffHunk {
  id: string              // Content-based hash for stable React keys
  startPos: number        // Character position in USER_EDITS
  userText: string        // Current user text (being replaced)
  aiText: string          // AI suggested text
}

// Simple hash function for stable hunk IDs
function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36)
}

// Singleton instance with configuration
const dmp = new DiffMatchPatch()
dmp.Diff_Timeout = 1  // 1 second max for large documents

export function useAIDiff(userEdits: string, aiVersion: string | null) {
  const [dismissedHunks, setDismissedHunks] = useState<Set<string>>(new Set())

  const hunks = useMemo(() => {
    if (!aiVersion) return []
    return computeDiffHunks(userEdits, aiVersion)
  }, [userEdits, aiVersion])

  const visibleHunks = hunks.filter(h => !dismissedHunks.has(h.id))

  const dismissHunk = (hunkId: string) => {
    setDismissedHunks(prev => new Set([...prev, hunkId]))
  }

  const resetDismissed = () => {
    setDismissedHunks(new Set())
  }

  return { hunks, visibleHunks, dismissHunk, resetDismissed }
}

function computeDiffHunks(userEdits: string, aiVersion: string): DiffHunk[] {
  // Compute diff with semantic cleanup
  const diffs = dmp.diff_main(userEdits, aiVersion)
  dmp.diff_cleanupSemantic(diffs)  // Merge small edits into meaningful chunks

  const hunks: DiffHunk[] = []
  let pos = 0

  for (let i = 0; i < diffs.length; i++) {
    const [op, text] = diffs[i]

    if (op === DIFF_EQUAL) {
      // Unchanged text - track position
      pos += text.length
      continue
    }

    // Found a change - collect consecutive DELETE/INSERT pairs
    let userText = ''
    let aiText = ''
    const startPos = pos

    // Collect all consecutive changes
    while (i < diffs.length && diffs[i][0] !== DIFF_EQUAL) {
      const [op, text] = diffs[i]
      if (op === DIFF_DELETE) {
        userText += text
        pos += text.length
      } else if (op === DIFF_INSERT) {
        aiText += text
      }
      i++
    }
    i-- // Adjust for loop increment

    // Use content-based hash for stable IDs across re-renders
    // This ensures dismissed hunks stay dismissed even after user edits elsewhere
    hunks.push({
      id: `hunk-${hashCode(userText + '|' + aiText)}`,
      startPos,
      userText,
      aiText,
    })
  }

  return hunks
}
```

### DiffHunk Component

```typescript
import DiffMatchPatch from 'diff-match-patch'

const DIFF_DELETE = -1
const DIFF_INSERT = 1
const DIFF_EQUAL = 0

interface DiffHunkProps {
  hunk: DiffHunk
  onAccept: () => void
  onReject: () => void
}

export function DiffHunkDisplay({ hunk, onAccept, onReject }: DiffHunkProps) {
  return (
    <div className="ai-hunk">
      <InlineDiff userText={hunk.userText} aiText={hunk.aiText} />
      <div className="ai-hunk-actions">
        <button onClick={onAccept} title="Accept AI suggestion">Accept</button>
        <button onClick={onReject} title="Reject AI suggestion">Reject</button>
      </div>
    </div>
  )
}

// Reuse singleton from useAIDiff or create local
const dmp = new DiffMatchPatch()

function InlineDiff({ userText, aiText }: { userText: string; aiText: string }) {
  // Word-level diff for inline display
  const diffs = dmp.diff_main(userText, aiText)
  dmp.diff_cleanupSemantic(diffs)

  return (
    <span>
      {diffs.map(([op, text], i) => {
        if (op === DIFF_DELETE) {
          return <del key={i} className="ai-removed">{text}</del>
        }
        if (op === DIFF_INSERT) {
          return <ins key={i} className="ai-added">{text}</ins>
        }
        return <span key={i}>{text}</span>
      })}
    </span>
  )
}
```

### AIToolbar Component

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
        <button onClick={onAcceptAll}>Accept All</button>
        <button onClick={onRejectAll}>Reject All</button>
      </div>
    </div>
  )
}
```

---

## Accept/Reject Logic

### Accept Hunk

```typescript
function acceptHunk(editor: CodeMirrorEditorRef, hunk: DiffHunk) {
  // Character-based replacement using diff-match-patch positions
  editor.replaceRange(
    hunk.startPos,
    hunk.startPos + hunk.userText.length,
    hunk.aiText
  )
  // Diff recomputes automatically since USER_EDITS changed
}
```

### Reject Hunk

```typescript
function rejectHunk(hunkId: string, dismissHunk: (id: string) => void) {
  // No document change - just hide this hunk
  dismissHunk(hunkId)
}
```

### Accept All

```typescript
function acceptAll(editor: CodeMirrorEditorRef, aiVersion: string, sessionId: string) {
  // Replace entire document with ai_version
  editor.replaceAll(aiVersion)
  api.aiSessions.resolve(sessionId, 'accepted')
}
```

### Reject All

```typescript
function rejectAll(sessionId: string) {
  // No document changes - just clear the session
  api.aiSessions.resolve(sessionId, 'rejected')
}
```

---

## Editor Integration (with CodeMirrorEditorRef)

The live diff feature sits **on top of** the core editor abstraction from Phase 0.7:

- `useAIDiff` works purely on strings (`USER_EDITS`, `ai_version`)
- An `EditorWithAISuggestions` component owns a `CodeMirrorEditorRef`
- All document changes for Accept / Accept All go through the ref (`replaceRange`, `replaceAll`)

This keeps:
- Single Responsibility: core editor manages CM6 state; AI diff manages comparison + UI
- Dependency Inversion: AI editing depends only on `CodeMirrorEditorRef`, not on `EditorView`

---

## CSS Styling

```css
/* Strikethrough for user's text being replaced */
.ai-removed {
  text-decoration: line-through;
  color: var(--text-muted);
  opacity: 0.7;
}

/* Highlighted for AI's suggested text */
.ai-added {
  background-color: rgba(34, 197, 94, 0.2);
  color: rgb(22, 163, 74);
  text-decoration: none;
}

/* Line with changes - subtle background */
.ai-changed-line {
  background-color: rgba(34, 197, 94, 0.08);
  border-left: 3px solid rgb(34, 197, 94);
}

/* Toolbar */
.ai-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: rgba(34, 197, 94, 0.1);
  border-bottom: 1px solid rgba(34, 197, 94, 0.2);
}

.ai-toolbar-count {
  font-size: 14px;
  color: rgb(22, 163, 74);
}

.ai-toolbar-actions {
  display: flex;
  gap: 8px;
}

/* Inline action buttons */
.ai-hunk-actions {
  display: inline-flex;
  gap: 4px;
  margin-left: 8px;
}

.ai-hunk-actions button {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 3px;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--background);
}

.ai-hunk-actions button:hover {
  background: var(--accent);
}
```

---

## Key Simplifications vs Original Design

| Original | Simplified |
|----------|------------|
| Character-range marks | Character-based diff hunks via diff-match-patch |
| Model B (edit inside = accept) | Explicit Accept/Reject only |
| Position hints in DB | Frontend computes diff |
| Complex StateField/StateEffect | React state + useMemo |
| Diff fallback for failed matches | We ARE the diff |
| Code-focused `diff` library | Semantic `diff-match-patch` for prose |

---

## Success Criteria

- [ ] `diff-match-patch` used with semantic cleanup
- [ ] `diff(USER_EDITS, ai_version)` computed live
- [ ] Word-level inline diff displayed (~~old~~ new)
- [ ] Whitespace-only changes handled gracefully (not noisy)
- [ ] Per-hunk Accept/Reject buttons work
- [ ] Accept All / Reject All work
- [ ] User can edit freely, diff recomputes
- [ ] Dismissed hunks don't reappear (content-based hunk IDs)
- [ ] Multi-line changes grouped sensibly (semantic cleanup)
- [ ] Line decorations highlight changed lines
- [ ] Large docs (50k+ words) debounce diff computation
- [ ] Loading indicator shown during slow diff
- [ ] Timeout fallback UI for very large documents
