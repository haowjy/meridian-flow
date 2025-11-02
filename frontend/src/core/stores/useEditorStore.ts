import { create } from 'zustand'

interface EditorStore {
  content: string
  isSaving: boolean
  lastSaved: Date | null
  syncStatus: 'saved' | 'saving' | 'local' | 'error'

  setContent: (content: string) => void
  saveDocument: () => Promise<void>
}

export const useEditorStore = create<EditorStore>()((set) => ({
  content: '',
  isSaving: false,
  lastSaved: null,
  syncStatus: 'saved',

  setContent: (content) => set({ content }),
  saveDocument: async () => {
    // TODO: Implement in Phase 4
  },
}))
