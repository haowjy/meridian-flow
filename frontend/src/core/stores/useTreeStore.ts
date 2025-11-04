import { create } from 'zustand'
import { Document } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'
import { buildTree, TreeNode } from '@/core/lib/treeBuilder'
import { api } from '@/core/lib/api'
import { getErrorMessage } from '@/core/lib/errors'
import { db } from '@/core/lib/db'
import { toast } from 'sonner'

interface TreeStore {
  documents: Document[]
  folders: Folder[]
  tree: TreeNode[]
  expandedFolders: Set<string>
  isLoading: boolean
  error: string | null

  loadTree: (projectId: string) => Promise<void>
  toggleFolder: (folderId: string) => void
}

// Track abort controller for loadTree to cancel previous requests
let loadTreeController: AbortController | null = null

export const useTreeStore = create<TreeStore>()((set) => ({
  documents: [],
  folders: [],
  tree: [],
  expandedFolders: new Set(),
  isLoading: false,
  error: null,

  loadTree: async (projectId: string) => {
    // Abort any previous loadTree request
    if (loadTreeController) {
      loadTreeController.abort()
    }

    // Create new controller for this request
    loadTreeController = new AbortController()
    const signal = loadTreeController.signal

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
      if (error instanceof Error && error.name === 'AbortError') {
        set({ isLoading: false })
        return
      }

      const message = getErrorMessage(error) || 'Failed to load documents'
      set({ error: message, isLoading: false })
      toast.error(message)
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
}))
