# Phase 6: Chat Integration (SuggestionCard)

**Dependencies**: Phase 2 (doc_edit Tool)

---

## Overview

Display a card in chat when AI uses `doc_edit` tool, showing edit count and linking user to the editor to review suggestions.

```
┌─────────────────────────────────────────┐
│ 📝 AI Edit Suggestion                   │
│                                         │
│ /Chapter 5.md                           │
│ 5 edits pending                         │
│                                         │
│ [View in Editor →]                      │
└─────────────────────────────────────────┘
```

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `frontend/src/features/chats/components/SuggestionCard.tsx` | Create |
| `frontend/src/features/chats/components/blocks/BlockRenderer.tsx` | Modify |

---

## SuggestionCard Component

```typescript
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/components/ui/card'
import { Button } from '@/shared/components/ui/button'
import { FileEdit, ArrowRight } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'

interface SuggestionCardProps {
  sessionId: string
  documentPath: string  // Unix-style path, e.g., "/Chapter 5.md"
  editCount: number     // Total edits in session
  projectId: string
}

export function SuggestionCard({
  sessionId,
  documentPath,
  editCount,
  projectId,
}: SuggestionCardProps) {
  const navigate = useNavigate()

  const handleViewInEditor = () => {
    navigate({
      to: '/_authenticated/projects/$projectId/documents',
      params: { projectId },
      search: {
        path: documentPath,
        session: sessionId,
      },
    })
  }

  return (
    <Card className="max-w-sm border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileEdit className="w-4 h-4 text-green-600" />
          AI Edit Suggestion
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm font-medium text-foreground font-mono">
          {documentPath}
        </p>
        <p className="text-xs text-muted-foreground">
          {editCount} edit{editCount !== 1 ? 's' : ''} pending
        </p>
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={handleViewInEditor}
        >
          View in Editor
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
      </CardContent>
    </Card>
  )
}
```

---

## BlockRenderer Integration

**File**: `frontend/src/features/chats/components/blocks/BlockRenderer.tsx`

Add handling for `doc_edit` tool results:

```typescript
import { SuggestionCard } from '../SuggestionCard'

// In tool_result handling:
function renderToolResult(block: ToolResultBlock, projectId: string) {
  const toolName = block.content.tool_name

  if (toolName === 'doc_edit') {
    const result = block.content.result

    // Only show card for editing commands (not view)
    if (result.success && result.session_id) {
      // Backend should resolve current document path from session's document_id
      return (
        <SuggestionCard
          sessionId={result.session_id}
          documentPath={result.path || '/document'}
          editCount={result.edit_count || 1}
          charDelta={result.char_delta || 0}
          projectId={projectId}
        />
      )
    }

    // For view command, show document content or error
    return <ToolResultText result={result} />
  }

  // ... other tool results
  return <DefaultToolResult block={block} />
}
```

---

## Tool Result Shape

The `doc_edit` tool returns different shapes based on command:

```typescript
// For str_replace, insert, append:
interface EditResult {
  success: true
  session_id: string
  edit_id: string
  path: string
  message: string
  edit_count?: number
  char_delta?: number
}

// For view:
interface ViewResult {
  success: true
  path: string
  content: string
  line_count: number
}

// For errors:
interface ErrorResult {
  success: false
  error: string
  error_code?: 'NO_MATCH' | 'AMBIGUOUS_MATCH' | 'DOC_NOT_FOUND' | 'SESSION_NOT_FOUND' | string
}
```

---

## Aggregating Multiple Edits

When AI makes multiple `doc_edit` calls in one turn, aggregate into single card:

```typescript
function aggregateDocEdits(blocks: Block[]): AggregatedEdit[] {
  const editsBySession = new Map<string, {
    sessionId: string
    path: string
    editCount: number
    charDelta: number
  }>()

  for (const block of blocks) {
    if (block.type === 'tool_result' && block.tool_name === 'doc_edit') {
      const result = block.result
      if (result.success && result.session_id) {
        const existing = editsBySession.get(result.session_id)
        if (existing) {
          existing.editCount++
          existing.charDelta += result.char_delta || 0
        } else {
          editsBySession.set(result.session_id, {
            sessionId: result.session_id,
            path: result.path,
            editCount: 1,
            charDelta: result.char_delta || 0,
          })
        }
      }
    }
  }

  return Array.from(editsBySession.values())
}
```

---

## Success Criteria

- [ ] Card appears when AI uses doc_edit with editing commands
- [ ] Shows document path (Unix-style)
- [ ] Shows edit count
- [ ] "View in Editor" navigates to document
- [ ] Document opens with AI session active
- [ ] Multiple edits to same document aggregate into one card
- [ ] View command results show content, not card
