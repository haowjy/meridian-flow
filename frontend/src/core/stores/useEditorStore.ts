import { create } from 'zustand'
import type { Document } from '@/features/documents/types/document'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'
import { api } from '@/core/lib/api'
import { db } from '@/core/lib/db'
import { loadWithPolicy, ReconcileNewestPolicy, ICacheRepo, IRemoteRepo } from '@/core/lib/cache'
import { documentSyncService } from '@/core/services/documentSyncService'
import { getErrorMessageWithFallback, isAbortError } from '@/core/lib/errors'
import { makeLogger } from '@/core/lib/logger'
import { useRecentDocumentsStore } from './useRecentDocumentsStore'

const logger = makeLogger('editor-store')

interface EditorStore {
  activeDocument: Document | null
  _activeDocumentId: string | null // Internal: track which doc SHOULD be active (race prevention)
  status: SaveStatus
  lastSaved: Date | null
  isLoading: boolean
  error: string | null
  hasUserEdit: boolean

  // Hunk navigation state (for AI diff review)
  focusedHunkIndex: number // -1 = no visual focus, 0+ = highlighted hunk
  navigatorPosition: number // Navigator display position (never -1, for "Change X/Y" display)
  navigatorPositionByDoc: Record<string, number> // Per-doc persistence for navigator position

  loadDocument: (documentId: string, signal?: AbortSignal) => Promise<void>
  saveDocument: (documentId: string, content: string) => Promise<void>
  setStatus: (status: SaveStatus) => void
  updateActiveDocument: (document: Document) => void
  setHasUserEdit: (hasEdit: boolean) => void
  /** Force refresh document from server (e.g., after AI edit tool) */
  refreshDocument: (documentId: string) => Promise<void>
  /** Set the focused hunk index for keyboard navigation */
  setFocusedHunkIndex: (index: number) => void
  /** Navigate to next/previous hunk (wraps around) */
  navigateHunk: (direction: 'next' | 'prev', totalHunks: number) => void
  /** Clamp navigator position when hunks are removed (called by useDiffView) */
  clampNavigatorPosition: (totalHunks: number) => void
  /** Clear the error state */
  clearError: () => void
}

export const useEditorStore = create<EditorStore>()((set, get) => ({
  activeDocument: null,
  _activeDocumentId: null,
  status: 'saved',
  lastSaved: null,
  isLoading: false,
  error: null,
  hasUserEdit: false,
  focusedHunkIndex: -1, // -1 = no visual focus, 0+ = highlighted hunk
  navigatorPosition: 0, // Navigator display position (never -1)
  navigatorPositionByDoc: {}, // Per-doc persistence for navigator position

  loadDocument: async (documentId: string, signal?: AbortSignal) => {
    // CRITICAL: Set expected document ID FIRST (synchronous, before any await)
    // This prevents race conditions when user rapidly switches documents
    // Restore navigator position from per-document map, or default to 0
    const savedPosition = get().navigatorPositionByDoc[documentId] ?? 0
    set({
      _activeDocumentId: documentId,
      isLoading: true,
      error: null,
      hasUserEdit: false, // Reset edit flag when switching docs
      focusedHunkIndex: -1, // Start without visual focus
      navigatorPosition: savedPosition, // Restore navigator position from per-doc map
    })

    logger.debug(`Starting load for document ${documentId}`)

    try {

      const cacheRepo: ICacheRepo<Document> = {
        get: async () => {
          const d = await db.documents.get(documentId)
          return d && d.content !== undefined ? d : undefined
        },
        put: async (doc) => {
          const withContent = doc as Document & { content?: unknown }
          if (withContent.content !== undefined) {
            await db.documents.put(withContent as Document & { content: string })
          }
        },
      }

      const remoteRepo: IRemoteRepo<Document> = {
        fetch: () => api.documents.get(documentId, { signal }),
      }

      await loadWithPolicy<Document>(new ReconcileNewestPolicy<Document>(), {
        cacheRepo,
        remoteRepo,
        signal,
        onIntermediate: (r) => {
          if (get()._activeDocumentId !== documentId) return
          // Show cached content immediately and allow UI to render
          set({ activeDocument: r.data, isLoading: false })
        },
      })
        .then((final) => {
          if (get()._activeDocumentId !== documentId) return
          set({ activeDocument: final.data, status: 'saved', isLoading: false })
          // Track recent document access (document has projectId from API response)
          useRecentDocumentsStore.getState().addRecent(final.data.projectId, documentId)
        })
        .catch((error) => {
          if (isAbortError(error)) {
            set({ isLoading: false })
            return
          }
          const message = getErrorMessageWithFallback(error, 'Failed to load document')
          set({ error: message, isLoading: false })
        })
    } catch (error) {
      // Handle AbortError silently (expected when user switches documents)
      if (isAbortError(error)) {
        logger.debug(`Aborted load for ${documentId}`)
        set({ isLoading: false })
        return
      }

      // Real errors: set error state for inline display
      const message = getErrorMessageWithFallback(error, 'Failed to load document')
      logger.error(`Failed to load document ${documentId}:`, error)
      set({ error: message, isLoading: false })
    }
  },

  saveDocument: async (documentId: string, content: string) => {
    logger.info('saveDocument called', { documentId, contentLength: content.length })
    set({ status: 'saving', error: null })
    const currentDoc = get().activeDocument
    try {
      await documentSyncService.save(documentId, content, currentDoc ?? undefined, {
        onServerSaved: (serverDoc) => {
          if (get()._activeDocumentId === documentId) {
            set({ activeDocument: serverDoc, status: 'saved', lastSaved: serverDoc.updatedAt, error: null })
          }
        },
        onRetryScheduled: () => {
          // Keep showing "saving" status while retry is pending
          // Status badge will show 'saving' state
          logger.debug('Save retry scheduled, keeping saving status')
        },
        onPermanentFailure: (err) => {
          const message = err instanceof Error ? err.message : 'Failed to sync after retries'
          set({ status: 'error', error: message })
        },
      })
    } catch (error) {
      // Client/validation errors (no retry)
      const message = getErrorMessageWithFallback(error, 'Failed to save document')
      set({ status: 'error', error: message })
    }
  },

  setStatus: (status) => set({ status }),

  updateActiveDocument: (document) =>
    set({
      activeDocument: document,
      lastSaved: document.updatedAt,
    }),

  setHasUserEdit: (hasEdit) => set({ hasUserEdit: hasEdit }),

  refreshDocument: async (documentId: string) => {
    // Skip if this isn't the active document
    if (get()._activeDocumentId !== documentId) return

    logger.debug(`Force refreshing document ${documentId}`)

    try {
      // Fetch fresh from server, bypassing cache comparison
      const doc = await api.documents.get(documentId)

      // Only update if still the active document
      if (get()._activeDocumentId !== documentId) return

      // Update state
      set({
        activeDocument: doc,
        status: 'saved',
        lastSaved: doc.updatedAt,
      })

      // Update cache with fresh data (ensure content is defined for IndexedDB)
      if (doc.content !== undefined) {
        await db.documents.put(doc as Document & { content: string })
      }

      logger.info(`Refreshed document ${documentId}`)
    } catch (error) {
      // Silent fail - this is a background refresh, not a user action
      logger.warn(`Failed to refresh document ${documentId}:`, error)
    }
  },

  setFocusedHunkIndex: (index) => {
    const docId = get()._activeDocumentId
    if (index === -1) {
      // Click outside: only remove visual focus, keep navigator position
      set({ focusedHunkIndex: -1 })
    } else {
      // Click inside or navigate: update both visual focus and navigator position
      set({
        focusedHunkIndex: index,
        navigatorPosition: index,
        // Also persist navigator position to per-document map
        ...(docId && {
          navigatorPositionByDoc: {
            ...get().navigatorPositionByDoc,
            [docId]: index,
          },
        }),
      })
    }
  },

  navigateHunk: (direction, totalHunks) => {
    if (totalHunks === 0) return

    const docId = get()._activeDocumentId
    set((state) => {
      // Use navigatorPosition as starting point (always valid, never -1)
      const current = state.navigatorPosition

      // Wrap around using modulo (cycle first↔last)
      const next =
        direction === 'next'
          ? (current + 1) % totalHunks // 2 → 0 when total=3
          : (current - 1 + totalHunks) % totalHunks // 0 → 2 when total=3

      // Update BOTH: visual focus returns, navigator moves
      return {
        focusedHunkIndex: next,
        navigatorPosition: next,
        // Also persist navigator position to per-document map
        ...(docId && {
          navigatorPositionByDoc: {
            ...state.navigatorPositionByDoc,
            [docId]: next,
          },
        }),
      }
    })
  },

  clampNavigatorPosition: (totalHunks) => {
    const docId = get()._activeDocumentId
    set((state) => {
      // No hunks: reset to 0
      if (totalHunks === 0) {
        return { navigatorPosition: 0 }
      }

      // Navigator position out of bounds: clamp to last hunk
      if (state.navigatorPosition >= totalHunks) {
        const clamped = totalHunks - 1
        return {
          navigatorPosition: clamped,
          // Also persist clamped position
          ...(docId && {
            navigatorPositionByDoc: {
              ...state.navigatorPositionByDoc,
              [docId]: clamped,
            },
          }),
        }
      }

      // Already in bounds: no change
      return {}
    })
  },

  clearError: () => set({ error: null }),
}))
