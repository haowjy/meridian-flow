# Phase 5: Accept/Reject UI

**Dependencies**: Phase 4 (TipTap Marks)
**Estimated Time**: 2-3 hours

---

## Overview

UI for accepting/rejecting individual suggestions and bulk actions.

```
┌─────────────────────────────────────────────┐
│ AI Suggestions (3 pending)  [Accept All] [✗]│
├─────────────────────────────────────────────┤
│                                             │
│  The [gentleman→man] entered the            │
│            ↑                                │
│    ┌───────────────────┐                    │
│    │ Accept │ Reject   │                    │
│    └───────────────────┘                    │
│                                             │
└─────────────────────────────────────────────┘
```

---

## Files to Create

| File | Action |
|------|--------|
| `frontend/src/features/documents/components/SuggestionPopover.tsx` | Hover UI |
| `frontend/src/features/documents/components/SuggestionToolbar.tsx` | Bulk actions |

---

## SuggestionPopover

```typescript
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/components/ui/popover'
import { Button } from '@/shared/components/ui/button'
import { Check, X } from 'lucide-react'

interface SuggestionPopoverProps {
  versionId: string
  original: string
  suggested: string
  onAccept: () => void
  onReject: () => void
  children: React.ReactNode
}

export function SuggestionPopover({
  versionId,
  original,
  suggested,
  onAccept,
  onReject,
  children,
}: SuggestionPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-64 p-2">
        <div className="space-y-2">
          <div className="text-sm">
            <span className="text-muted-foreground line-through">{original}</span>
            <span className="mx-1">→</span>
            <span className="text-green-600 font-medium">{suggested}</span>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="default" onClick={onAccept}>
              <Check className="w-4 h-4 mr-1" /> Accept
            </Button>
            <Button size="sm" variant="outline" onClick={onReject}>
              <X className="w-4 h-4 mr-1" /> Reject
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
```

---

## SuggestionToolbar

```typescript
interface SuggestionToolbarProps {
  count: number
  onAcceptAll: () => void
  onRejectAll: () => void
}

export function SuggestionToolbar({
  count,
  onAcceptAll,
  onRejectAll,
}: SuggestionToolbarProps) {
  if (count === 0) return null

  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-green-50 dark:bg-green-950 border-b">
      <span className="text-sm text-green-700 dark:text-green-300">
        {count} AI suggestion{count !== 1 ? 's' : ''} pending
      </span>
      <div className="flex-1" />
      <Button size="sm" variant="default" onClick={onAcceptAll}>
        Accept All
      </Button>
      <Button size="sm" variant="ghost" onClick={onRejectAll}>
        Reject All
      </Button>
    </div>
  )
}
```

---

## Accept Flow

```typescript
async function handleAccept(versionId: string) {
  // 1. Call API to accept
  await api.documents.acceptSuggestion(documentId, versionId)

  // 2. Reload document (now has accepted content)
  await refreshDocument()

  // 3. Remaining suggestions need re-diffing against new content
  // (handled by useSuggestions hook on content change)
}
```

---

## Success Criteria

- [ ] Hover on suggestion shows popover
- [ ] Accept updates document and removes mark
- [ ] Reject removes mark without updating document
- [ ] Accept All applies all suggestions
- [ ] Reject All removes all marks
- [ ] Toolbar shows pending count
