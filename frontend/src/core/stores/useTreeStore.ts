import { create } from 'zustand'
import { Document } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'
import { buildTree, TreeNode } from '@/core/lib/treeBuilder'
import { api } from '@/core/lib/api'
import { getErrorMessageWithFallback, isAbortError } from '@/core/lib/errors'
import { db } from '@/core/lib/db'
import { cancelRetry } from '@/core/lib/sync'

type LoadStatus = 'idle' | 'loading' | 'success' | 'error'

interface TreeStore {
  documents: Document[]
  folders: Folder[]
  tree: TreeNode[]
  expandedFolders: Set<string>
  status: LoadStatus
  isFetching: boolean
  error: string | null

  // Computed getter for backwards compatibility
  isLoading: boolean

  loadTree: (projectId: string, signal?: AbortSignal) => Promise<void>
  toggleFolder: (folderId: string) => void
  expandFolder: (folderId: string) => void
  createDocument: (projectId: string, folderId: string | null, name: string) => Promise<void>
  createFolder: (projectId: string, parentId: string | null, name: string) => Promise<void>
  deleteDocument: (id: string, projectId: string) => Promise<void>
  deleteFolder: (id: string, projectId: string) => Promise<void>
  renameDocument: (id: string, name: string, projectId: string) => Promise<void>
  renameFolder: (id: string, name: string, projectId: string) => Promise<void>
  clearError: () => void
}

export const useTreeStore = create<TreeStore>()((set, get) => ({
  documents: [],
  folders: [],
  tree: [],
  expandedFolders: new Set(),
  status: 'idle' as LoadStatus,
  isFetching: false,
  error: null,

  // Computed getter for backwards compatibility
  get isLoading() {
    return get().status === 'loading'
  },

  loadTree: async (projectId: string, signal?: AbortSignal) => {
    // Set loading state based on whether we have cached tree data
    const currentState = get()
    const status = currentState.tree.length === 0 ? 'loading' : 'success'
    set({ status, isFetching: true, error: null })

    try {
      // Fetch tree from backend (already flattened by fromDocumentTreeDto mapper)
      const response = await api.documents.getTree(projectId, { signal })

      // Build hierarchical tree structure from flat arrays
      const tree = buildTree(response.folders, response.documents)

      // Cache full documents in IndexedDB (only those with content)
      const fullDocuments = response.documents.filter((doc): doc is Document & { content: string } =>
        doc.content !== undefined
      )
      if (fullDocuments.length > 0) {
        await Promise.all(fullDocuments.map((doc) => db.documents.put(doc)))
      }

      // Update store
      set({
        folders: response.folders,
        documents: response.documents,
        tree,
        status: 'success',
        isFetching: false,
      })
    } catch (error) {
      // Handle AbortError silently (expected when loading new project)
      if (isAbortError(error)) {
        set({ isFetching: false })
        return
      }

      const message = getErrorMessageWithFallback(error, 'Failed to load documents')
      // If we have cached tree data, keep status as 'success', otherwise set to 'error'
      const currentTree = get().tree
      const errorStatus = currentTree.length > 0 ? 'success' : 'error'
      set({ error: message, status: errorStatus, isFetching: false })
    }
  },

  toggleFolder: (folderId) => {
    set((state) => {
      const expanded = new Set(state.expandedFolders)
      if (expanded.has(folderId)) {
        expanded.delete(folderId)
      } else {
        expanded.add(folderId)
      }
      return { expandedFolders: expanded }
    })
  },

  expandFolder: (folderId) => {
    set((state) => {
      if (state.expandedFolders.has(folderId)) return state
      const expanded = new Set(state.expandedFolders)
      expanded.add(folderId)
      return { expandedFolders: expanded }
    })
  },

  createDocument: async (projectId, folderId, name) => {
    set({ error: null })
    try {
      await api.documents.create(projectId, folderId, name)
      // Reload tree to reflect new document
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      const message = getErrorMessageWithFallback(error, 'Failed to create document')
      set({ error: message })
      throw error
    }
  },

  createFolder: async (projectId, parentId, name) => {
    set({ error: null })
    try {
      await api.folders.create(projectId, parentId, name)
      // Reload tree to reflect new folder
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      const message = getErrorMessageWithFallback(error, 'Failed to create folder')
      set({ error: message })
      throw error
    }
  },

  deleteDocument: async (id, projectId) => {
    set({ error: null })
    try {
      // Cancel any pending retries FIRST to prevent stale content from being re-synced
      // after we delete the document from cache and server
      cancelRetry(id)

      // Clear from IndexedDB cache to prevent race conditions
      // where URL sync might try to load a deleted document
      await db.documents.delete(id)
      await api.documents.delete(id)
      // Reload tree to reflect deletion
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      const message = getErrorMessageWithFallback(error, 'Failed to delete document')
      set({ error: message })
      throw error
    }
  },

  deleteFolder: async (id, projectId) => {
    set({ error: null })
    try {
      await api.folders.delete(id)
      // Reload tree to reflect deletion
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      const message = getErrorMessageWithFallback(error, 'Failed to delete folder')
      set({ error: message })
      throw error
    }
  },

  renameDocument: async (id, name, projectId) => {
    set({ error: null })
    try {
      await api.documents.rename(id, projectId, name)
      // Reload tree to reflect rename
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      const message = getErrorMessageWithFallback(error, 'Failed to rename document')
      set({ error: message })
      throw error
    }
  },

  renameFolder: async (id, name, projectId) => {
    set({ error: null })
    try {
      await api.folders.rename(id, projectId, name)
      // Reload tree to reflect rename
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      const message = getErrorMessageWithFallback(error, 'Failed to rename folder')
      set({ error: message })
      throw error
    }
  },

  clearError: () => set({ error: null }),
}))
