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
 * Active panel for mobile single-panel mode.
 * Only one panel is visible at a time on mobile.
 */
export type MobileActivePanel = 'chatList' | 'activeChat' | 'document'

/**
 * UI state store for workspace layout and panel management.
 * Persisted to localStorage: leftPanelCollapsed, rightPanelCollapsed, activeDocumentId, activeChatId.
 * Not persisted: rightPanelState (resets to 'documents'), chatFocusVersion.
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
   * Monotonic counter used to drive chat input auto-focus.
   * Incremented when "New Chat" is pressed so the input refocuses even if
   * the activeChatId does not change (e.g., cold-start state).
   */
  chatFocusVersion: number

  /**
   * Active panel for mobile single-panel mode.
   * Determines which panel is visible when viewport < 768px.
   * Persisted across sessions.
   * @default 'activeChat' (first run only)
   */
  mobileActivePanel: MobileActivePanel

  /** Toggles left panel collapsed/expanded state */
  toggleLeftPanel: () => void

  /** Toggles right panel collapsed/expanded state */
  toggleRightPanel: () => void

  /**
   * Sets right panel view mode.
   * Use panelHelpers.openDocument() for opening documents (navigates URL).
   * Call directly with 'documents' to show tree view without navigating.
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

  /** Bumps chatFocusVersion to request chat input focus. */
  bumpChatFocusVersion: () => void

  /**
   * Sets active panel for mobile layout.
   * Use for tab navigation on mobile viewport.
   */
  setMobileActivePanel: (panel: MobileActivePanel) => void
}

export const useUIStore = create<UIStore>()(
  persist(
    (set) => ({
      leftPanelCollapsed: false,
      rightPanelCollapsed: true,
      rightPanelState: 'documents',
      activeDocumentId: null,
      activeChatId: null,
      chatFocusVersion: 0,
      mobileActivePanel: 'activeChat',

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
      bumpChatFocusVersion: () =>
        set((state) => ({ chatFocusVersion: state.chatFocusVersion + 1 })),
      setMobileActivePanel: (panel) =>
        set({ mobileActivePanel: panel }),
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({
        leftPanelCollapsed: state.leftPanelCollapsed,
        rightPanelCollapsed: state.rightPanelCollapsed,
        activeDocumentId: state.activeDocumentId,
        activeChatId: state.activeChatId,
        mobileActivePanel: state.mobileActivePanel,
        // chatFocusVersion is ephemeral and not persisted

        // rightPanelState excluded - always resets to 'documents' on page load
      }),
    }
  )
)
