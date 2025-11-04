import { create } from 'zustand'
import type { Document } from '@/features/documents/types/document'
import type { SaveStatus } from '@/shared/components/ui/StatusBadge'
import { api } from '@/core/lib/api'
import { db } from '@/core/lib/db'
import { countWords } from '@/core/lib/countWords'
import { queueSync } from '@/core/lib/sync'
import { toast } from 'sonner'

interface EditorStore {
  activeDocument: Document | null
  wordCount: number
  status: SaveStatus
  lastSaved: Date | null
  isLoading: boolean
  error: string | null

  loadDocument: (documentId: string, signal?: AbortSignal) => Promise<void>
  saveDocument: (documentId: string, content: string) => Promise<void>
  setStatus: (status: SaveStatus) => void
}

export const useEditorStore = create<EditorStore>()((set) => ({
  activeDocument: null,
  wordCount: 0,
  status: 'saved',
  lastSaved: null,
  isLoading: false,
  error: null,

  loadDocument: async (documentId: string, signal?: AbortSignal) => {
    set({ isLoading: true, error: null })

    try {
      // Step 1: Check IndexedDB cache for full document
      const cached = await db.documents.get(documentId)

      if (cached && cached.content) {
        // Cache hit: Full document available, display immediately
        set({
          activeDocument: cached,
          wordCount: countWords(cached.content),
          status: 'saved',
          isLoading: false,
        })

        // Background refresh: check server for updates
        try {
          const document = await api.documents.get(documentId, { signal })

          // If server version is newer, update cache and store
          if (document.updatedAt > cached.updatedAt) {
            if (document.content) {
              await db.documents.put(document as Document & { content: string })
            }

            set({
              activeDocument: document,
              wordCount: countWords(document.content),
            })
          }
        } catch (error) {
          // Silently handle background refresh failures (cache is still valid)
          if (error instanceof Error && error.name !== 'AbortError') {
            console.error('Background refresh failed:', error)
          }
        }

        return
      }

      // Step 2: Cache miss or stub → fetch from backend
      const document = await api.documents.get(documentId, { signal })

      // Step 3: Save full document to IndexedDB for next time
      if (document.content) {
        await db.documents.put(document as Document & { content: string })
      }

      // Step 4: Update store
      set({
        activeDocument: document,
        wordCount: countWords(document.content),
        status: 'saved',
        isLoading: false,
      })
    } catch (error) {
      // Handle AbortError silently (expected when user switches documents)
      if (error instanceof Error && error.name === 'AbortError') {
        set({ isLoading: false })
        return
      }

      // Real errors: show to user
      const message = error instanceof Error ? error.message : 'Failed to load document'
      set({ error: message, isLoading: false })
      toast.error(message)
    }
  },

  saveDocument: async (documentId: string, content: string) => {
    set({ status: 'saving' })

    try {
      const now = new Date()
      const words = countWords(content)

      // Get current document for fallback put if update fails
      const currentDoc = useEditorStore.getState().activeDocument

      // Step 1: Save to IndexedDB (authoritative, local-first)
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

      // Step 2: Update store state
      set((state) => ({
        activeDocument: state.activeDocument
          ? { ...state.activeDocument, content, updatedAt: now }
          : null,
        wordCount: words,
        lastSaved: now,
        status: 'local',
      }))

      // Step 3: Queue sync operation for background processing
      await queueSync({
        operation: 'update',
        entityType: 'document',
        entityId: documentId,
        data: { content },
      })
    } catch (error) {
      // Save failed: show error status
      set({ status: 'error' })
      const message = error instanceof Error ? error.message : 'Failed to save document'
      toast.error(message)
    }
  },

  setStatus: (status) => set({ status }),
}))
