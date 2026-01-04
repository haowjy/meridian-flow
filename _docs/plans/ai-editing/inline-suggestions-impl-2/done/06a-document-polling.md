# Phase 6a: Document Polling (v1)

## Goal

Detect when `ai_version` changes from background AI processes using polling.
SSE is deferred to a future version.

## What You're Building

1. **Frontend**: `useDocumentPolling` hook to detect changes
2. **Integration**: Trigger refresh flow when AI updates document

## Why Polling First

- No backend changes required
- Simpler to implement and debug
- Sufficient for v1 where background AI updates are infrequent
- Easy to swap for SSE later (same callback interface)

## Steps

### Step 6a.1: Create useDocumentPolling hook

Create `frontend/src/features/documents/hooks/useDocumentPolling.ts`:

```typescript
import { useEffect, useRef, useCallback } from 'react'
import { api } from '@/core/lib/api'
import type { Document } from '@/types'

interface DocumentPollingOptions {
  /** Polling interval in ms. Default: 5000 */
  intervalMs?: number
  /** Skip polling when true (e.g., user is actively editing) */
  paused?: boolean
}

interface DocumentPollingHandlers {
  /** Called when ai_version_rev changes on the server */
  onAIVersionChanged?: (newRev: number, document: Document) => void
  /** Called when polling encounters an error */
  onError?: (error: Error) => void
}

/**
 * Poll for document changes when AI might update in the background.
 *
 * Only polls when:
 * - documentId is defined
 * - paused is false (editor is not dirty)
 * - hasAIVersion is true (AI session is active)
 *
 * @example
 * ```tsx
 * useDocumentPolling(
 *   activeDocument?.id,
 *   aiVersionBaseRevRef.current,
 *   hasAISuggestions,
 *   {
 *     onAIVersionChanged: (newRev, doc) => {
 *       if (hasUserEdit) {
 *         setPendingServerSnapshot(doc)
 *       } else {
 *         handleRefreshFromServer(doc)
 *       }
 *     },
 *   },
 *   { paused: hasUserEdit }
 * )
 * ```
 */
export function useDocumentPolling(
  documentId: string | undefined,
  currentAIVersionRev: number | null,
  hasAIVersion: boolean,
  handlers: DocumentPollingHandlers,
  options: DocumentPollingOptions = {}
) {
  const { intervalMs = 5000, paused = false } = options

  // Use refs to avoid re-creating the interval when these change
  const currentRevRef = useRef(currentAIVersionRev)
  const handlersRef = useRef(handlers)

  // Keep refs in sync
  useEffect(() => {
    currentRevRef.current = currentAIVersionRev
  }, [currentAIVersionRev])

  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  // Polling logic
  useEffect(() => {
    // Skip polling if:
    // - No document ID
    // - Paused (user is editing)
    // - No AI version (nothing to track)
    if (!documentId || paused || !hasAIVersion) {
      return
    }

    let isActive = true

    const poll = async () => {
      if (!isActive) return

      try {
        const doc = await api.documents.get(documentId)
        const newRev = doc.aiVersionRev

        // Only notify if rev changed AND we have a baseline to compare
        if (
          isActive &&
          newRev !== null &&
          currentRevRef.current !== null &&
          newRev !== currentRevRef.current
        ) {
          handlersRef.current.onAIVersionChanged?.(newRev, doc)
        }
      } catch (error) {
        if (isActive) {
          handlersRef.current.onError?.(error as Error)
        }
      }
    }

    // Start polling
    const interval = setInterval(poll, intervalMs)

    // Also poll immediately on mount/resume
    poll()

    return () => {
      isActive = false
      clearInterval(interval)
    }
  }, [documentId, paused, hasAIVersion, intervalMs])
}
```

---

### Step 6a.2: Integrate in EditorPanel

Update `frontend/src/features/documents/components/EditorPanel.tsx`:

```typescript
import { useDocumentPolling } from '../hooks/useDocumentPolling'

// Inside EditorPanel component:

// Handle AI version change from polling
const handleAIVersionChanged = useCallback((newRev: number, doc: Document) => {
  console.log('[EditorPanel] AI version changed:', { newRev, current: aiVersionBaseRevRef.current })

  if (hasUserEdit) {
    // Editor is dirty: stash and show "Refresh" banner
    // Don't overwrite the editor content
    setPendingServerSnapshot({
      content: doc.content ?? '',
      aiVersion: doc.aiVersion,
      aiVersionRev: doc.aiVersionRev,
    })
  } else {
    // Editor is clean: auto-refresh
    // Update local state and hydrate editor
    const content = doc.content ?? ''
    const aiVersion = doc.aiVersion

    if (aiVersion !== null && aiVersion !== undefined) {
      const merged = buildMergedDocument(content, aiVersion)
      setLocalDocument(merged)
      aiVersionBaseRevRef.current = doc.aiVersionRev ?? null

      if (editorRef.current) {
        editorRef.current.setContent(merged, { addToHistory: false, emitChange: false })
      }
    } else {
      // AI was cleared on server
      setLocalDocument(content)
      aiVersionBaseRevRef.current = null

      if (editorRef.current) {
        editorRef.current.setContent(content, { addToHistory: false, emitChange: false })
      }
    }

    // Clear any pending snapshot since we just refreshed
    setPendingServerSnapshot(null)
  }
}, [hasUserEdit])

const handlePollingError = useCallback((error: Error) => {
  // Log but don't disrupt the user - polling will retry
  console.warn('[EditorPanel] Polling error:', error.message)
}, [])

// Start polling when AI session is active
useDocumentPolling(
  activeDocument?.id,
  aiVersionBaseRevRef.current,
  hasAISuggestions,  // Only poll when there's an AI session
  {
    onAIVersionChanged: handleAIVersionChanged,
    onError: handlePollingError,
  },
  {
    paused: hasUserEdit,  // Pause while user is typing
    intervalMs: 5000,     // Poll every 5 seconds
  }
)
```

---

### Step 6a.3: Add polling indicator (optional)

For debugging/visibility, you can show a subtle indicator when polling is active:

```tsx
// In EditorPanel JSX, near the toolbar:
{hasAISuggestions && !hasUserEdit && (
  <span className="text-xs text-muted-foreground animate-pulse" title="Checking for AI updates...">
    ●
  </span>
)}
```

---

## Optimizations (Future)

### Option A: HEAD request with ETag

Reduce bandwidth by only fetching headers:

```typescript
// Backend: Return ai_version_rev in response headers
// GET /api/documents/{id} with If-None-Match
// Returns 304 Not Modified if unchanged

const checkForUpdate = async (documentId: string, currentRev: number) => {
  const response = await fetch(`/api/documents/${documentId}`, {
    method: 'HEAD',
    headers: { 'If-None-Match': `"${currentRev}"` }
  })

  if (response.status === 304) return null  // No change
  if (response.status === 200) {
    // Changed - fetch full document
    return api.documents.get(documentId)
  }
}
```

### Option B: Lightweight revision endpoint

Create a dedicated endpoint that only returns the revision:

```
GET /api/documents/{id}/revision
{ "ai_version_rev": 5 }
```

---

## Future: SSE Upgrade Path

When ready to upgrade to real-time updates:

1. Add backend SSE endpoint `/api/documents/{id}/events`
2. Create `useDocumentEvents` hook with EventSource
3. Replace `useDocumentPolling` call with `useDocumentEvents`
4. Same handler interface - no other changes needed

```typescript
// Future useDocumentEvents hook (same interface)
export function useDocumentEvents(
  documentId: string | undefined,
  currentAIVersionRev: number | null,
  hasAIVersion: boolean,
  handlers: DocumentEventHandlers,  // Same interface
  options?: { /* SSE-specific options */ }
) {
  // EventSource implementation instead of polling
}
```

---

## Synchronization Note: Polling + Save Race

When a save completes, the polling hook resumes (because `hasUserEdit` becomes `false`). To prevent false-positive "server updated" detections, the save callback MUST update `aiVersionBaseRevRef.current` **before** calling `setHasUserEdit(false)`.

```typescript
// Correct order in onServerSaved callback:
aiVersionBaseRevRef.current = result.document.aiVersionRev  // First
setHasUserEdit(false)  // Then polling resumes
```

If the order is reversed, polling may see a stale `aiVersionBaseRevRef.current` and incorrectly report that the server has a newer version.

---

## Verification Checklist

- [ ] Polling starts when AI session is active (`hasAISuggestions = true`)
- [ ] Polling pauses when user is editing (`hasUserEdit = true`)
- [ ] Polling resumes when user saves (edit completes)
- [ ] **After save completes, no spurious "Server updated" banners appear**
- [ ] Dirty editor shows "Refresh" banner on change detected
- [ ] Clean editor auto-refreshes on change detected
- [ ] Polling stops when document changes (switching docs)
- [ ] Polling stops on unmount
- [ ] Errors are logged but don't crash the UI

## Files Created

| File | Purpose |
|------|---------|
| `frontend/src/features/documents/hooks/useDocumentPolling.ts` | Polling hook |

## Files Modified

| File | Change |
|------|--------|
| `frontend/src/features/documents/components/EditorPanel.tsx` | Use polling hook |

## Next Step

→ Continue to `07-cleanup-and-clipboard.md` for save-time safety and clipboard handling.
