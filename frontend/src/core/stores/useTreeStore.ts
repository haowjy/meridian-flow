import { create } from 'zustand'
import { Document } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'
import { buildTree, TreeNode } from '@/core/lib/treeBuilder'
import { api } from '@/core/lib/api'
import { getErrorMessage, handleApiError, isAbortError } from '@/core/lib/errors'
import { db } from '@/core/lib/db'

interface TreeStore {
  documents: Document[]
  folders: Folder[]
  tree: TreeNode[]
  expandedFolders: Set<string>
  isLoading: boolean
  error: string | null

  loadTree: (projectId: string, signal?: AbortSignal) => Promise<void>
  toggleFolder: (folderId: string) => void
  createDocument: (projectId: string, folderId: string | null, name: string) => Promise<void>
  createFolder: (projectId: string, parentId: string | null, name: string) => Promise<void>
  deleteDocument: (id: string, projectId: string) => Promise<void>
  deleteFolder: (id: string, projectId: string) => Promise<void>
  renameDocument: (id: string, name: string, projectId: string) => Promise<void>
  renameFolder: (id: string, name: string, projectId: string) => Promise<void>
}

export const useTreeStore = create<TreeStore>()((set) => ({
  documents: [],
  folders: [],
  tree: [],
  expandedFolders: new Set(),
  isLoading: false,
  error: null,

  loadTree: async (projectId: string, signal?: AbortSignal) => {
    set({ isLoading: true, error: null })

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
        isLoading: false,
      })
    } catch (error) {
      // Handle AbortError silently (expected when loading new project)
      if (isAbortError(error)) {
        set({ isLoading: false })
        return
      }

      const message = getErrorMessage(error) || 'Failed to load documents'
      set({ error: message, isLoading: false })
      handleApiError(error, 'Failed to load documents')
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

  createDocument: async (projectId, folderId, name) => {
    try {
      await api.documents.create(projectId, folderId, name)
      // Reload tree to reflect new document
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      handleApiError(error, 'Failed to create document')
      throw error
    }
  },

  createFolder: async (projectId, parentId, name) => {
    try {
      await api.folders.create(projectId, parentId, name)
      // Reload tree to reflect new folder
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      handleApiError(error, 'Failed to create folder')
      throw error
    }
  },

  deleteDocument: async (id, projectId) => {
    try {
      await api.documents.delete(id)
      // Remove from IndexedDB cache
      await db.documents.delete(id)
      // Reload tree to reflect deletion
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      handleApiError(error, 'Failed to delete document')
      throw error
    }
  },

  deleteFolder: async (id, projectId) => {
    try {
      await api.folders.delete(id)
      // Reload tree to reflect deletion
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      handleApiError(error, 'Failed to delete folder')
      throw error
    }
  },

  renameDocument: async (id, name, projectId) => {
    try {
      await api.documents.rename(id, name)
      // Reload tree to reflect rename
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      handleApiError(error, 'Failed to rename document')
      throw error
    }
  },

  renameFolder: async (id, name, projectId) => {
    try {
      await api.folders.rename(id, name)
      // Reload tree to reflect rename
      await useTreeStore.getState().loadTree(projectId)
    } catch (error) {
      handleApiError(error, 'Failed to rename folder')
      throw error
    }
  },
}))
