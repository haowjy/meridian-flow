import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Represents the current view mode of the right panel.
 * - 'documents': Shows document tree/file explorer
 * - 'editor': Shows document editor
 * - null: No specific mode (initial state)
 */
export type RightPanelState = 'documents' | 'editor' | null

/**
 * UI state store for workspace layout and panel management.
 * All state is persisted to localStorage except rightPanelState (resets to 'documents' on reload).
 */
interface UIStore {
  /**
   * Controls left panel (chat list) visibility.
   * Persisted across sessions.
   * @default false
   */
  leftPanelCollapsed: boolean

  /**
   * Controls right panel (documents/editor) visibility.
   * Persisted across sessions.
   * @default true (collapsed by default to maximize writing space)
   */
  rightPanelCollapsed: boolean

  /**
   * Determines right panel content: 'documents' (tree view) or 'editor'.
   * NOT persisted - always resets to 'documents' on page load.
   * Use panelHelpers.openDocument() to coordinate opening editor.
   * @default 'documents'
   */
  rightPanelState: RightPanelState

  /**
   * ID of currently active document (for highlighting in tree + editor).
   * Persisted across sessions.
   * Null if no document is active.
   * @default null
   */
  activeDocumentId: string | null

  /**
   * ID of currently active chat (for highlighting in chat list).
   * Persisted across sessions.
   * Null if no chat is active.
   * @default null
   */
  activeChatId: string | null

  /**
   * Controls editor read-only mode.
   * Persisted across sessions.
   * @default true (read-only by default for AI agent-centric workflows)
   */
  editorReadOnly: boolean

  /** Toggles left panel collapsed/expanded state */
  toggleLeftPanel: () => void

  /** Toggles right panel collapsed/expanded state */
  toggleRightPanel: () => void

  /**
   * Sets right panel view mode.
   * Use panelHelpers.openDocument() or closeEditor() for coordinated state updates.
   */
  setRightPanelState: (state: RightPanelState) => void

  /** Directly sets right panel collapsed state (prefer toggleRightPanel) */
  setRightPanelCollapsed: (collapsed: boolean) => void

  /**
   * Sets active document ID.
   * Use panelHelpers.openDocument() to also open editor and expand panel.
   */
  setActiveDocument: (id: string | null) => void

  /**
   * Sets active chat ID.
   * Use panelHelpers.switchChat() for semantic clarity.
   */
  setActiveChat: (id: string | null) => void

  /** Toggles editor between read-only and edit modes */
  toggleEditorReadOnly: () => void
  /** Explicitly sets editor read-only mode */
  setEditorReadOnly: (readOnly: boolean) => void
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      leftPanelCollapsed: false,
      rightPanelCollapsed: true,
      rightPanelState: 'documents',
      activeDocumentId: null,
      activeChatId: null,
      editorReadOnly: true,

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
      toggleEditorReadOnly: () =>
        set((state) => ({ editorReadOnly: !state.editorReadOnly })),
      setEditorReadOnly: (readOnly) =>
        set({ editorReadOnly: readOnly }),
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({
        leftPanelCollapsed: state.leftPanelCollapsed,
        rightPanelCollapsed: state.rightPanelCollapsed,
        activeDocumentId: state.activeDocumentId,
        activeChatId: state.activeChatId,
        editorReadOnly: state.editorReadOnly,
        // rightPanelState excluded - always resets to 'documents' on page load
      }),
    }
  )
)
