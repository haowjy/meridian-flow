import { create } from 'zustand'
import { Document } from '@/features/documents/types/document'
import { Folder } from '@/features/folders/types/folder'

interface TreeStore {
  documents: Document[]
  folders: Folder[]
  expandedFolders: Set<string>

  loadTree: (projectId: string) => Promise<void>
  toggleFolder: (folderId: string) => void
}

export const useTreeStore = create<TreeStore>()((set) => ({
  documents: [],
  folders: [],
  expandedFolders: new Set(),

  loadTree: async (projectId) => {
    // TODO: Implement in Phase 4
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
