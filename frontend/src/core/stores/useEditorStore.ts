import { create } from 'zustand'
import type { Document } from '@/features/documents/types/document'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'
import { api } from '@/core/lib/api'
import { db } from '@/core/lib/db'
import { loadWithPolicy, ReconcileNewestPolicy, ICacheRepo, IRemoteRepo } from '@/core/lib/cache'
import { syncDocument, addRetryOperation, cancelRetry, isNetworkError } from '@/core/lib/sync'
import { toast } from 'sonner'

interface EditorStore {
  activeDocument: Document | null
  _activeDocumentId: string | null // Internal: track which doc SHOULD be active (race prevention)
  status: SaveStatus
  lastSaved: Date | null
  isLoading: boolean
  error: string | null
  hasUserEdit: boolean

  loadDocument: (documentId: string, signal?: AbortSignal) => Promise<void>
  saveDocument: (documentId: string, content: string) => Promise<void>
  setStatus: (status: SaveStatus) => void
  updateActiveDocument: (document: Document) => void
  setHasUserEdit: (hasEdit: boolean) => void
}

export const useEditorStore = create<EditorStore>()((set, get) => ({
  activeDocument: null,
  _activeDocumentId: null,
  status: 'saved',
  lastSaved: null,
  isLoading: false,
  error: null,
  hasUserEdit: false,

  loadDocument: async (documentId: string, signal?: AbortSignal) => {
    // CRITICAL: Set expected document ID FIRST (synchronous, before any await)
    // This prevents race conditions when user rapidly switches documents
    set({
      _activeDocumentId: documentId,
      isLoading: true,
      error: null,
      hasUserEdit: false, // Reset edit flag when switching docs
    })

    console.log(`[Load] Starting load for document ${documentId}`)

    try {

      const cacheRepo: ICacheRepo<Document> = {
        get: async () => {
          const d = await db.documents.get(documentId)
          return d && d.content !== undefined ? d : undefined
        },
        put: async (doc) => {
          if ((doc as any).content !== undefined) {
            await db.documents.put(doc as Document & { content: string })
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
          if (error instanceof Error && error.name === 'AbortError') {
            set({ isLoading: false })
            return
          }
          const message = error instanceof Error ? error.message : 'Failed to load document'
          set({ error: message, isLoading: false })
          toast.error(message)
        })
    } catch (error) {
      // Handle AbortError silently (expected when user switches documents)
      if (error instanceof Error && error.name === 'AbortError') {
        console.log(`[Load] Aborted load for ${documentId}`)
        set({ isLoading: false })
        return
      }

      // Real errors: show to user
      const message = error instanceof Error ? error.message : 'Failed to load document'
      console.error(`[Load] Failed to load document ${documentId}:`, error)
      set({ error: message, isLoading: false })
      toast.error(message)
    }
  },

  saveDocument: async (documentId: string, content: string) => {
    set({ status: 'saving' })

    // Cancel any pending retry for this document (user kept typing, newer content wins)
    cancelRetry(documentId)

    try {
      const now = new Date()

      // Get current document for fallback put if update fails
      const currentDoc = get().activeDocument

      // Step 1: Optimistic update to IndexedDB (instant feedback)
      const updated = await db.documents.update(documentId, {
        content,
        updatedAt: now,
      })

      // If update failed (document doesn't exist in IndexedDB), insert it
      if (updated === 0 && currentDoc && currentDoc.id === documentId) {
        await db.documents.put({
          ...currentDoc,
          content,
          updatedAt: now,
        })
      }

      // Step 2: Direct sync to backend (no queue)
      try {
        const serverDoc = await syncDocument(documentId, content)

        // Step 3: Apply server response (source of truth for timestamps)
        set({
          activeDocument: serverDoc,
          status: 'saved',
          lastSaved: serverDoc.updatedAt,
        })
      } catch (error) {
        // Sync failed - check if it's a network error or client error
        if (isNetworkError(error)) {
          // Network error: Queue for automatic retry
          addRetryOperation({
            entityType: 'document',
            entityId: documentId,
            content,
            attemptCount: 0,
          })

          // Keep showing "saving" status while retry is pending
          // User will see "saved" when retry succeeds
          toast.info('Syncing changes...', { duration: 2000 })
        } else {
          // Client error (400, 404, validation): Show error, don't retry
          set({ status: 'error' })
          const message = error instanceof Error ? error.message : 'Failed to save document'
          toast.error(`Save failed: ${message}`, {
            duration: 10000,
            action: {
              label: 'Retry',
              onClick: () => {
                // Manual retry
                get().saveDocument(documentId, content)
              },
            },
          })
        }
      }
    } catch (error) {
      // IndexedDB save failed (rare)
      set({ status: 'error' })
      const message = error instanceof Error ? error.message : 'Failed to save document locally'
      toast.error(message)
    }
  },

  setStatus: (status) => set({ status }),

  updateActiveDocument: (document) =>
    set({
      activeDocument: document,
      lastSaved: document.updatedAt,
    }),

  setHasUserEdit: (hasEdit) => set({ hasUserEdit: hasEdit }),
}))
