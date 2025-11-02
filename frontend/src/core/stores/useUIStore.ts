import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface UIStore {
  leftPanelCollapsed: boolean
  rightPanelCollapsed: boolean
  activeDocumentId: string | null

  toggleLeftPanel: () => void
  toggleRightPanel: () => void
  setActiveDocument: (id: string | null) => void
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      leftPanelCollapsed: false,
      rightPanelCollapsed: true,
      activeDocumentId: null,

      toggleLeftPanel: () =>
        set((state) => ({ leftPanelCollapsed: !state.leftPanelCollapsed })),
      toggleRightPanel: () =>
        set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed })),
      setActiveDocument: (id) =>
        set({ activeDocumentId: id }),
    }),
    {
      name: 'ui-store',
    }
  )
)
