# Phase 4: TipTap Suggestion Marks

**Dependencies**: Phase 3 (Version API)
**Estimated Time**: 4-5 hours (most complex frontend phase)

---

## Overview

Display AI suggestions as inline marks in the TipTap editor, similar to Google Docs suggestions.

```
Before:
"The man entered the tavern."

With AI suggestion:
"The [man→gentleman] entered the [tavern→opulent tavern]."
   └── strikethrough + green highlight
```

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `frontend/src/core/editor/extensions/SuggestionMark.ts` | Create | TipTap mark extension |
| `frontend/src/core/editor/extensions/index.ts` | Modify | Export new extension |
| `frontend/src/features/documents/hooks/useSuggestions.ts` | Create | Fetch and manage suggestions |
| `frontend/src/features/documents/utils/diffCalculator.ts` | Create | Calculate diff positions |

---

## Architecture

```mermaid
flowchart TD
    subgraph "Suggestion Flow"
        API[GET /documents/:id/suggestions] --> Hook[useSuggestions]
        Hook --> Diff[diffCalculator]
        Diff --> Marks[Apply TipTap marks]
    end

    subgraph "Editor"
        Marks --> Editor[TipTap Editor]
        Editor --> Render[Suggestion rendering]
    end

    style Hook fill:#2d7d2d
    style Diff fill:#2d5f8d
```

---

## TipTap Mark Extension

**File**: `frontend/src/core/editor/extensions/SuggestionMark.ts`

```typescript
import { Mark, mergeAttributes } from '@tiptap/core'

export interface SuggestionMarkOptions {
  HTMLAttributes: Record<string, unknown>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    suggestionMark: {
      setSuggestion: (attrs: { versionId: string; original: string; suggested: string }) => ReturnType
      unsetSuggestion: () => ReturnType
    }
  }
}

export const SuggestionMark = Mark.create<SuggestionMarkOptions>({
  name: 'suggestion',

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      versionId: {
        default: null,
      },
      original: {
        default: '',
      },
      suggested: {
        default: '',
      },
      type: {
        default: 'replace', // 'replace', 'insert', 'delete'
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-suggestion]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-suggestion': '',
        class: 'suggestion-mark',
      }),
      0, // Content placeholder
    ]
  },

  addCommands() {
    return {
      setSuggestion:
        (attributes) =>
        ({ commands }) => {
          return commands.setMark(this.name, attributes)
        },
      unsetSuggestion:
        () =>
        ({ commands }) => {
          return commands.unsetMark(this.name)
        },
    }
  },
})
```

---

## CSS Styling

**File**: `frontend/src/globals.css` (add to existing)

```css
/* AI Suggestion marks */
.suggestion-mark {
  position: relative;
  background-color: rgba(34, 197, 94, 0.2); /* green-500 with opacity */
  border-bottom: 2px solid rgb(34, 197, 94);
  cursor: pointer;
}

.suggestion-mark::before {
  /* Original text (strikethrough) */
  content: attr(data-original);
  text-decoration: line-through;
  color: var(--text-muted);
  margin-right: 4px;
}

.suggestion-mark:hover {
  background-color: rgba(34, 197, 94, 0.3);
}

/* Delete suggestion */
.suggestion-mark[data-type="delete"] {
  background-color: rgba(239, 68, 68, 0.2); /* red-500 */
  border-bottom-color: rgb(239, 68, 68);
}

/* Insert suggestion */
.suggestion-mark[data-type="insert"] {
  background-color: rgba(34, 197, 94, 0.3);
}
```

---

## Diff Calculator

**File**: `frontend/src/features/documents/utils/diffCalculator.ts`

```typescript
import { diffWords } from 'diff' // npm install diff

export interface SuggestionEdit {
  type: 'replace' | 'insert' | 'delete'
  start: number
  end: number
  original: string
  suggested: string
}

export function calculateSuggestionEdits(
  currentContent: string,
  suggestedContent: string
): SuggestionEdit[] {
  const diffs = diffWords(currentContent, suggestedContent)
  const edits: SuggestionEdit[] = []

  let currentPos = 0

  for (let i = 0; i < diffs.length; i++) {
    const diff = diffs[i]

    if (diff.removed) {
      const nextDiff = diffs[i + 1]

      if (nextDiff?.added) {
        // Replace: removed + added
        edits.push({
          type: 'replace',
          start: currentPos,
          end: currentPos + diff.value.length,
          original: diff.value,
          suggested: nextDiff.value,
        })
        i++ // Skip next diff (already processed)
      } else {
        // Delete only
        edits.push({
          type: 'delete',
          start: currentPos,
          end: currentPos + diff.value.length,
          original: diff.value,
          suggested: '',
        })
      }
      currentPos += diff.value.length
    } else if (diff.added) {
      // Insert only
      edits.push({
        type: 'insert',
        start: currentPos,
        end: currentPos,
        original: '',
        suggested: diff.value,
      })
      // Don't advance currentPos for insert
    } else {
      // Unchanged
      currentPos += diff.value.length
    }
  }

  return edits
}
```

---

## useSuggestions Hook

**File**: `frontend/src/features/documents/hooks/useSuggestions.ts`

```typescript
import { useEffect, useState } from 'react'
import { api } from '@/core/lib/api'
import { calculateSuggestionEdits, SuggestionEdit } from '../utils/diffCalculator'

interface Suggestion {
  id: string
  description: string
  createdAt: string
  content: string
}

interface AppliedSuggestion {
  versionId: string
  edits: SuggestionEdit[]
}

export function useSuggestions(documentId: string, currentContent: string) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [appliedEdits, setAppliedEdits] = useState<AppliedSuggestion[]>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    if (!documentId) return

    async function fetchSuggestions() {
      setIsLoading(true)
      try {
        const response = await api.documents.getSuggestions(documentId)
        setSuggestions(response.suggestions)

        // Calculate edits for each suggestion
        const applied = response.suggestions.map((suggestion) => ({
          versionId: suggestion.id,
          edits: calculateSuggestionEdits(currentContent, suggestion.content),
        }))
        setAppliedEdits(applied)
      } catch (error) {
        console.error('Failed to fetch suggestions:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchSuggestions()
  }, [documentId, currentContent])

  const acceptSuggestion = async (versionId: string) => {
    await api.documents.acceptSuggestion(documentId, versionId)
    // Refresh document content (handled by parent)
  }

  const rejectSuggestion = async (versionId: string) => {
    await api.documents.rejectSuggestion(documentId, versionId)
    setSuggestions((prev) => prev.filter((s) => s.id !== versionId))
    setAppliedEdits((prev) => prev.filter((a) => a.versionId !== versionId))
  }

  return {
    suggestions,
    appliedEdits,
    isLoading,
    acceptSuggestion,
    rejectSuggestion,
  }
}
```

---

## Editor Integration

**File**: `frontend/src/features/documents/components/EditorPanel.tsx` (modify)

```typescript
import { SuggestionMark } from '@/core/editor/extensions/SuggestionMark'
import { useSuggestions } from '../hooks/useSuggestions'

// Add SuggestionMark to extensions
const extensions = [
  // ... existing extensions
  SuggestionMark,
]

// In component:
const { appliedEdits, acceptSuggestion, rejectSuggestion } = useSuggestions(
  documentId,
  editor?.getMarkdown() ?? ''
)

// Apply marks when suggestions load
useEffect(() => {
  if (!editor || appliedEdits.length === 0) return

  appliedEdits.forEach(({ versionId, edits }) => {
    edits.forEach((edit) => {
      editor
        .chain()
        .focus()
        .setTextSelection({ from: edit.start, to: edit.end })
        .setSuggestion({
          versionId,
          original: edit.original,
          suggested: edit.suggested,
        })
        .run()
    })
  })
}, [editor, appliedEdits])
```

---

## Testing Checklist

- [ ] Suggestions fetch on document load
- [ ] Diff calculation produces correct edit positions
- [ ] Marks render with correct styling
- [ ] Replace shows strikethrough + new text
- [ ] Delete shows strikethrough only
- [ ] Insert shows new text with green highlight
- [ ] Multiple suggestions can coexist

---

## Success Criteria

- [ ] AI suggestions appear as inline marks
- [ ] Visual distinction between replace/insert/delete
- [ ] Marks are clickable (for accept/reject UI)
- [ ] Performance acceptable with large documents
