import { create } from 'zustand'
import type { Document } from '@/features/documents/types/document'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'
import { api } from '@/core/lib/api'
import { db } from '@/core/lib/db'
import { loadWithPolicy, ReconcileNewestPolicy, ICacheRepo, IRemoteRepo } from '@/core/lib/cache'
import { documentSyncService } from '@/core/services/documentSyncService'
import { cancelAIVersionClearRetry } from '@/core/lib/sync'
import { handleApiError, isAbortError } from '@/core/lib/errors'
import { toast } from 'sonner'
import { makeLogger } from '@/core/lib/logger'

const logger = makeLogger('editor-store')

/**
 * Editor mode when reviewing AI suggestions.
 *
 * - 'changes': Unified diff view showing inline additions/deletions (default)
 * - 'aiDraft': Plain editor showing only the AI draft (no diff markers)
 * - 'original': Read-only view of original content before AI changes
 *
 * @see `_docs/plans/ai-editing/inline-suggestions.md` for full UX spec
 */
export type AIEditorMode = 'changes' | 'aiDraft' | 'original'

interface EditorStore {
  activeDocument: Document | null
  _activeDocumentId: string | null // Internal: track which doc SHOULD be active (race prevention)
  status: SaveStatus
  lastSaved: Date | null
  isLoading: boolean
  error: string | null
  hasUserEdit: boolean

  // AI suggestion review mode (only relevant when document.aiVersion exists)
  aiEditorMode: AIEditorMode

  loadDocument: (documentId: string, signal?: AbortSignal) => Promise<void>
  saveDocument: (documentId: string, content: string) => Promise<void>
  setStatus: (status: SaveStatus) => void
  updateActiveDocument: (document: Document) => void
  setHasUserEdit: (hasEdit: boolean) => void
  /** Force refresh document from server (e.g., after AI edit tool) */
  refreshDocument: (documentId: string) => Promise<void>
  /** Set the AI editor mode (changes/aiDraft/original) */
  setAIEditorMode: (mode: AIEditorMode) => void
}

export const useEditorStore = create<EditorStore>()((set, get) => ({
  activeDocument: null,
  _activeDocumentId: null,
  status: 'saved',
  lastSaved: null,
  isLoading: false,
  error: null,
  hasUserEdit: false,
  aiEditorMode: 'changes', // Default to unified diff view when reviewing AI suggestions

  loadDocument: async (documentId: string, signal?: AbortSignal) => {
    // Get previous document ID before overwriting
    const previousDocumentId = get()._activeDocumentId

    // Cancel any pending AI version clear retry for the previous document
    // to prevent clearing AI version on the wrong document when user switches quickly
    if (previousDocumentId && previousDocumentId !== documentId) {
      cancelAIVersionClearRetry(previousDocumentId)
    }

    // CRITICAL: Set expected document ID FIRST (synchronous, before any await)
    // This prevents race conditions when user rapidly switches documents
    set({
      _activeDocumentId: documentId,
      isLoading: true,
      error: null,
      hasUserEdit: false, // Reset edit flag when switching docs
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
        })
        .catch((error) => {
          if (isAbortError(error)) {
            set({ isLoading: false })
            return
          }
          const message = error instanceof Error ? error.message : 'Failed to load document'
          set({ error: message, isLoading: false })
          handleApiError(error, 'Failed to load document')
        })
    } catch (error) {
      // Handle AbortError silently (expected when user switches documents)
      if (isAbortError(error)) {
        logger.debug(`Aborted load for ${documentId}`)
        set({ isLoading: false })
        return
      }

      // Real errors: show to user
      const message = error instanceof Error ? error.message : 'Failed to load document'
      logger.error(`Failed to load document ${documentId}:`, error)
      set({ error: message, isLoading: false })
      handleApiError(error, 'Failed to load document')
    }
  },

  saveDocument: async (documentId: string, content: string) => {
    logger.info('saveDocument called', { documentId, contentLength: content.length })
    set({ status: 'saving' })
    const currentDoc = get().activeDocument
    try {
      await documentSyncService.save(documentId, content, currentDoc ?? undefined, {
        onServerSaved: (serverDoc) => {
          if (get()._activeDocumentId === documentId) {
            set({ activeDocument: serverDoc, status: 'saved', lastSaved: serverDoc.updatedAt })
          }
        },
        onRetryScheduled: () => {
          // Keep showing "saving" status while retry is pending
          toast.info('Syncing changes...', { duration: 2000 })
        },
        onPermanentFailure: (err) => {
          set({ status: 'error' })
          const message = err instanceof Error ? err.message : 'Failed to sync after retries'
          toast.error(message, { duration: 10000 })
        },
      })
    } catch (error) {
      // Client/validation errors (no retry)
      set({ status: 'error' })
      const message = error instanceof Error ? error.message : 'Failed to save document'
      toast.error(`Save failed: ${message}`, {
        duration: 10000,
        action: {
          label: 'Retry',
          onClick: () => get().saveDocument(documentId, content),
        },
      })
      // Also funnel through centralized handler for consistency/logging
      handleApiError(error, 'Failed to save document')
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

  setAIEditorMode: (mode) => set({ aiEditorMode: mode }),
}))
