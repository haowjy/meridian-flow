# Phase 4: State & Sync

## Goal
Extend the Zustand store and sync service to handle:
1. Accept/reject hunk operations
2. Dual-document updates (when editing outside hunks)
3. Race condition prevention with locks
4. Atomic server sync for both documents

## Steps

### Step 4.1: Add the API method for dual updates

Update `frontend/src/core/lib/api.ts`:

Find the `documents` object and add:

```typescript
documents: {
  // ... existing methods (list, get, create, update, delete, etc.)

  /**
   * Update both content and ai_version atomically.
   * Used for accept/reject operations and dual-document edits.
   *
   * @param id - Document ID
   * @param content - New baseline content
   * @param aiVersion - New AI version (null to clear)
   */
  updateBoth: async (
    id: string,
    content: string,
    aiVersion: string | null,
    options?: { signal?: AbortSignal }
  ): Promise<Document> => {
    const data = await fetchAPI<DocumentDto>(`/api/documents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        content,
        ai_version: aiVersion,
      }),
      signal: options?.signal,
    })
    return fromDocumentDto(data)
  },
}
```

---

### Step 4.2: Extend the DocumentSyncService

Update `frontend/src/core/services/documentSyncService.ts`:

Add these new methods:

```typescript
/**
 * Save both content and aiVersion atomically.
 * Used for accept/reject operations and dual-document edits.
 *
 * @param documentId - Document to update
 * @param content - New baseline content
 * @param aiVersion - New AI version (null to clear and resolve session)
 * @param cbs - Optional callbacks for success/retry/failure
 */
async saveBoth(
  documentId: string,
  content: string,
  aiVersion: string | null,
  cbs?: SaveCallbacks
): Promise<void> {
  // Cancel any pending single-doc retries
  cancelRetry(documentId)

  const now = new Date()

  // Optimistic update to IndexedDB
  await db.documents.update(documentId, {
    content,
    aiVersion: aiVersion ?? undefined,
    updatedAt: now,
  })

  try {
    const serverDoc = await api.documents.updateBoth(
      documentId,
      content,
      aiVersion
    )
    cbs?.onServerSaved?.(serverDoc)
  } catch (error) {
    if (isNetworkError(error)) {
      // Queue retry with both values
      // Note: You may want to create a separate retry queue for dual-doc ops
      this.queueBothRetry(documentId, content, aiVersion, cbs)
      cbs?.onRetryScheduled?.()
      return
    }
    throw error
  }
}

/**
 * Save content and clear aiVersion (resolve AI session).
 * Used when accepting all hunks or when content === aiVersion.
 */
async saveAndClearAiVersion(
  documentId: string,
  content: string,
  cbs?: SaveCallbacks
): Promise<void> {
  return this.saveBoth(documentId, content, null, cbs)
}

/**
 * Queue a retry for dual-document update.
 * Note: For simplicity, this uses the same retry mechanism.
 * Consider a dedicated queue if retry semantics differ.
 */
private queueBothRetry(
  documentId: string,
  content: string,
  aiVersion: string | null,
  cbs?: SaveCallbacks
): void {
  // For now, we'll retry the full save
  // In production, you might want a more sophisticated approach
  addRetryOperation(
    {
      id: documentId,
      operation: async () => {
        const serverDoc = await api.documents.updateBoth(
          documentId,
          content,
          aiVersion
        )
        return serverDoc
      },
    },
    cbs
  )
}
```

---

### Step 4.3: Extend the editor store

Update `frontend/src/core/stores/useEditorStore.ts`:

Add these new state fields and actions. First, update the interface:

```typescript
interface EditorStore {
  // ... existing fields ...

  // New fields for hunk operations
  /** Lock to prevent concurrent accept/reject operations */
  isHunkOpInProgress: boolean

  /** Currently focused hunk index (for keyboard navigation) */
  focusedHunkIndex: number

  // New actions
  /** Accept a single hunk */
  acceptHunk: (hunk: WordDiffHunk) => Promise<void>

  /** Reject a single hunk */
  rejectHunk: (hunk: WordDiffHunk) => Promise<void>

  /** Accept all hunks (apply full AI version) */
  acceptAllHunks: () => Promise<void>

  /** Reject all hunks (discard AI version) */
  rejectAllHunks: () => Promise<void>

  /** Update both documents (for dual-doc edits) */
  updateBothDocuments: (content: string, aiVersion: string) => void

  /** Navigate to next/previous hunk */
  navigateHunk: (direction: 'next' | 'prev', totalHunks: number) => void
}
```

Add the import at the top:

```typescript
import type { WordDiffHunk } from '@/core/editor/codemirror/diffView/types'
import { applyAcceptHunk, applyRejectHunk } from '@/features/documents/hooks/useWordDiff'
```

Add the new state and actions in the store:

```typescript
export const useEditorStore = create<EditorStore>()((set, get) => ({
  // ... existing state and actions ...

  // New state
  isHunkOpInProgress: false,
  focusedHunkIndex: 0,

  // New actions

  acceptHunk: async (hunk) => {
    const { activeDocument, isHunkOpInProgress, _activeDocumentId } = get()

    // Guard: prevent concurrent operations
    if (isHunkOpInProgress) {
      logger.warn('Hunk operation already in progress')
      return
    }

    if (!activeDocument?.content || !activeDocument.aiVersion) {
      logger.warn('Cannot accept hunk: missing content or aiVersion')
      return
    }

    set({ isHunkOpInProgress: true })

    try {
      // Apply accept: put AI text into content
      const newContent = applyAcceptHunk(activeDocument.content, hunk)

      // Recompute: after accept, this hunk no longer exists
      // The content now matches the aiVersion at this position
      // We need to also update aiVersion to remove the "change"
      // Actually, for accept: we're updating content to match aiVersion
      // So aiVersion stays the same, content changes

      // Check if all changes are now accepted
      const allAccepted = newContent === activeDocument.aiVersion

      // Update local state immediately (optimistic)
      set({
        activeDocument: {
          ...activeDocument,
          content: newContent,
          aiVersion: allAccepted ? null : activeDocument.aiVersion,
        },
      })

      // Sync to server
      if (allAccepted) {
        await documentSyncService.saveAndClearAiVersion(
          activeDocument.id,
          newContent,
          {
            onServerSaved: (serverDoc) => {
              if (get()._activeDocumentId === _activeDocumentId) {
                set({ activeDocument: serverDoc })
              }
            },
            onRetryScheduled: () => {
              logger.info('Accept retry scheduled')
            },
          }
        )
      } else {
        await documentSyncService.saveBoth(
          activeDocument.id,
          newContent,
          activeDocument.aiVersion,
          {
            onServerSaved: (serverDoc) => {
              if (get()._activeDocumentId === _activeDocumentId) {
                set({ activeDocument: serverDoc })
              }
            },
          }
        )
      }
    } catch (error) {
      logger.error('Accept hunk failed:', error)
      // Could revert optimistic update here if needed
    } finally {
      if (get()._activeDocumentId === _activeDocumentId) {
        set({ isHunkOpInProgress: false })
      }
    }
  },

  rejectHunk: async (hunk) => {
    const { activeDocument, isHunkOpInProgress, _activeDocumentId } = get()

    if (isHunkOpInProgress) {
      logger.warn('Hunk operation already in progress')
      return
    }

    if (!activeDocument?.content || !activeDocument.aiVersion) {
      logger.warn('Cannot reject hunk: missing content or aiVersion')
      return
    }

    set({ isHunkOpInProgress: true })

    try {
      // Apply reject: put original text back into aiVersion
      const newAiVersion = applyRejectHunk(activeDocument.aiVersion, hunk)

      // Check if all changes are now rejected
      const allRejected = activeDocument.content === newAiVersion

      // Update local state
      set({
        activeDocument: {
          ...activeDocument,
          aiVersion: allRejected ? null : newAiVersion,
        },
      })

      // Sync to server
      if (allRejected) {
        await documentSyncService.clearAIVersion(activeDocument.id, {
          onServerSaved: (serverDoc) => {
            if (get()._activeDocumentId === _activeDocumentId) {
              set({ activeDocument: serverDoc })
            }
          },
        })
      } else {
        await documentSyncService.saveBoth(
          activeDocument.id,
          activeDocument.content,
          newAiVersion,
          {
            onServerSaved: (serverDoc) => {
              if (get()._activeDocumentId === _activeDocumentId) {
                set({ activeDocument: serverDoc })
              }
            },
          }
        )
      }
    } catch (error) {
      logger.error('Reject hunk failed:', error)
    } finally {
      if (get()._activeDocumentId === _activeDocumentId) {
        set({ isHunkOpInProgress: false })
      }
    }
  },

  acceptAllHunks: async () => {
    const { activeDocument, isHunkOpInProgress, _activeDocumentId } = get()

    if (isHunkOpInProgress) return
    if (!activeDocument?.aiVersion) return

    set({ isHunkOpInProgress: true })

    try {
      // Accept all = use aiVersion as new content
      const newContent = activeDocument.aiVersion

      set({
        activeDocument: {
          ...activeDocument,
          content: newContent,
          aiVersion: null,
        },
      })

      await documentSyncService.saveAndClearAiVersion(
        activeDocument.id,
        newContent,
        {
          onServerSaved: (serverDoc) => {
            if (get()._activeDocumentId === _activeDocumentId) {
              set({ activeDocument: serverDoc })
            }
          },
        }
      )
    } catch (error) {
      logger.error('Accept all failed:', error)
    } finally {
      if (get()._activeDocumentId === _activeDocumentId) {
        set({ isHunkOpInProgress: false })
      }
    }
  },

  rejectAllHunks: async () => {
    const { activeDocument, isHunkOpInProgress, _activeDocumentId } = get()

    if (isHunkOpInProgress) return
    if (!activeDocument?.aiVersion) return

    set({ isHunkOpInProgress: true })

    try {
      // Reject all = discard aiVersion, keep content
      set({
        activeDocument: {
          ...activeDocument,
          aiVersion: null,
        },
      })

      await documentSyncService.clearAIVersion(activeDocument.id, {
        onServerSaved: (serverDoc) => {
          if (get()._activeDocumentId === _activeDocumentId) {
            set({ activeDocument: serverDoc })
          }
        },
      })
    } catch (error) {
      logger.error('Reject all failed:', error)
    } finally {
      if (get()._activeDocumentId === _activeDocumentId) {
        set({ isHunkOpInProgress: false })
      }
    }
  },

  updateBothDocuments: (content, aiVersion) => {
    const { activeDocument, _activeDocumentId } = get()

    if (!activeDocument) return

    // Update local state immediately
    set({
      activeDocument: {
        ...activeDocument,
        content,
        aiVersion,
      },
    })

    // Debounced save (uses the existing save pattern)
    // Note: This should be debounced similar to normal content saves
    documentSyncService.saveBoth(
      activeDocument.id,
      content,
      aiVersion,
      {
        onServerSaved: (serverDoc) => {
          if (get()._activeDocumentId === _activeDocumentId) {
            set({ activeDocument: serverDoc })
          }
        },
      }
    )
  },

  navigateHunk: (direction, totalHunks) => {
    if (totalHunks === 0) return

    set((state) => {
      const current = state.focusedHunkIndex
      let next: number

      if (direction === 'next') {
        next = current >= totalHunks - 1 ? 0 : current + 1
      } else {
        next = current <= 0 ? totalHunks - 1 : current - 1
      }

      return { focusedHunkIndex: next }
    })
  },
}))
```

---

### Step 4.4: Add the backend API endpoint (if needed)

If your backend doesn't already support updating both `content` and `ai_version` in a single PATCH request, you'll need to add that.

**Go backend example** (in `internal/handler/document.go`):

```go
// UpdateDocumentRequest now supports both fields
type UpdateDocumentRequest struct {
    Name      *string `json:"name,omitempty"`
    Content   *string `json:"content,omitempty"`
    AIVersion *string `json:"ai_version,omitempty"`  // Add this
    FolderID  *string `json:"folder_id,omitempty"`
}

// In the handler:
if req.AIVersion != nil {
    updates["ai_version"] = req.AIVersion
}
```

---

## Race Condition Prevention Summary

The implementation includes these guards:

| Guard | Purpose | Location |
|-------|---------|----------|
| `isHunkOpInProgress` | Prevents concurrent accept/reject | Store actions |
| `_activeDocumentId` | Prevents stale updates | Store callbacks |
| `cancelRetry()` | Cancels old retries before new ops | DocumentSyncService |
| Intent flag check | Guards async completion | All async operations |

---

## Verification Checklist

Before moving to Phase 5, verify:

- [ ] `api.documents.updateBoth()` method added
- [ ] `documentSyncService.saveBoth()` method added
- [ ] Store extended with `isHunkOpInProgress` lock
- [ ] `acceptHunk()` action works correctly
- [ ] `rejectHunk()` action works correctly
- [ ] `acceptAllHunks()` action works correctly
- [ ] `rejectAllHunks()` action works correctly
- [ ] `updateBothDocuments()` action works correctly
- [ ] Concurrent operations are blocked
- [ ] Server sync happens after operations

## Files Modified

| File | Action |
|------|--------|
| `frontend/src/core/lib/api.ts` | Modified (added `updateBoth`) |
| `frontend/src/core/services/documentSyncService.ts` | Modified (added `saveBoth`) |
| `frontend/src/core/stores/useEditorStore.ts` | Modified (added hunk ops) |
| `backend/internal/handler/document.go` | Modified (if needed) |

## Next Step

→ Continue to `05-ui-components.md` to build the navigator pill and hunk actions
