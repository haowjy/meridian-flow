import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type RightPanelState = 'documents' | 'editor' | null

interface UIStore {
  leftPanelCollapsed: boolean
  rightPanelCollapsed: boolean
  rightPanelState: RightPanelState
  activeDocumentId: string | null
  activeChatId: string | null

  toggleLeftPanel: () => void
  toggleRightPanel: () => void
  setRightPanelState: (state: RightPanelState) => void
  setRightPanelCollapsed: (collapsed: boolean) => void
  setActiveDocument: (id: string | null) => void
  setActiveChat: (id: string | null) => void
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      leftPanelCollapsed: false,
      rightPanelCollapsed: true,
      rightPanelState: 'documents',
      activeDocumentId: null,
      activeChatId: null,

      toggleLeftPanel: () =>
        set((state) => ({ leftPanelCollapsed: !state.leftPanelCollapsed })),
      toggleRightPanel: () =>
        set((state) => ({ rightPanelCollapsed: !state.rightPanelCollapsed })),
      setRightPanelState: (state) =>
        set({ rightPanelState: state }),
      setRightPanelCollapsed: (collapsed) =>
        set({ rightPanelCollapsed: collapsed }),
      setActiveDocument: (id) =>
        set({ activeDocumentId: id }),
      setActiveChat: (id) =>
        set({ activeChatId: id }),
    }),
    {
      name: 'ui-store',
    }
  )
)
