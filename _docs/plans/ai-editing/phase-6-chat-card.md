# Phase 6: Chat Integration (SuggestionCard)

**Dependencies**: Phase 2 (Suggest Tool)
**Estimated Time**: 1-2 hours

---

## Overview

Display a card in chat when AI uses `suggest_document_edits` tool, linking user to editor.

```
┌─────────────────────────────────────────┐
│ 📝 AI Suggestion                        │
│                                         │
│ Made the opening more suspenseful       │
│                                         │
│ +45 characters, 3 changes               │
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
  versionId: string
  documentId: string
  description: string
  editCount: number
  charDelta: number
  projectId: string
}

export function SuggestionCard({
  versionId,
  documentId,
  description,
  editCount,
  charDelta,
  projectId,
}: SuggestionCardProps) {
  const navigate = useNavigate()

  const handleViewInEditor = () => {
    // Navigate to document with suggestion highlight
    navigate({
      to: '/_authenticated/projects/$projectId/documents/$documentId',
      params: { projectId, documentId },
      search: { suggestion: versionId },
    })
  }

  return (
    <Card className="border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileEdit className="w-4 h-4 text-green-600" />
          AI Suggestion
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-foreground">{description}</p>
        <p className="text-xs text-muted-foreground">
          {charDelta >= 0 ? '+' : ''}{charDelta} characters, {editCount} change{editCount !== 1 ? 's' : ''}
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

Add handling for `suggest_document_edits` tool results:

```typescript
import { SuggestionCard } from '../SuggestionCard'

// In tool_result handling:
if (block.blockType === 'tool_result') {
  const toolName = block.content.tool_name

  if (toolName === 'suggest_document_edits') {
    const result = block.content.result
    return (
      <SuggestionCard
        versionId={result.version_id}
        documentId={result.document_id}
        description={result.description}
        editCount={result.edit_count}
        charDelta={result.char_delta}
        projectId={projectId}
      />
    )
  }

  // ... other tool results
}
```

---

## Success Criteria

- [ ] Card appears when AI uses suggest_document_edits
- [ ] Shows description, edit count, char delta
- [ ] "View in Editor" navigates to document
- [ ] Document opens with suggestion highlighted
