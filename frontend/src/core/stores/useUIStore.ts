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
export type MobileActivePanel = 'threadList' | 'activeThread' | 'document'

/**
 * UI state store for workspace layout and panel management.
 * Persisted to localStorage: leftPanelCollapsed, rightPanelCollapsed, activeDocumentId, activeThreadId.
 * Not persisted: rightPanelState (resets to 'documents'), threadFocusVersion.
 */
interface UIStore {
  /**
   * Controls left panel (thread list) visibility.
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
   * ID of currently active thread (for highlighting in thread list).
   * Persisted across sessions.
   * Null if no thread is active.
   * @default null
   */
  activeThreadId: string | null

  /**
   * Monotonic counter used to drive thread input auto-focus.
   * Incremented when "New Thread" is pressed so the input refocuses even if
   * the activeThreadId does not change (e.g., cold-start state).
   */
  threadFocusVersion: number

  /**
   * Active panel for mobile single-panel mode.
   * Determines which panel is visible when viewport < 768px.
   * Persisted across sessions.
   * @default 'activeThread' (first run only)
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
   * Sets active thread ID.
   * Use panelHelpers.switchThread() for semantic clarity.
   */
  setActiveThread: (id: string | null) => void

  /** Bumps threadFocusVersion to request thread input focus. */
  bumpThreadFocusVersion: () => void

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
      activeThreadId: null,
      threadFocusVersion: 0,
      mobileActivePanel: 'activeThread',

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
      setActiveThread: (id) =>
        set({ activeThreadId: id }),
      bumpThreadFocusVersion: () =>
        set((state) => ({ threadFocusVersion: state.threadFocusVersion + 1 })),
      setMobileActivePanel: (panel) =>
        set({ mobileActivePanel: panel }),
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({
        leftPanelCollapsed: state.leftPanelCollapsed,
        rightPanelCollapsed: state.rightPanelCollapsed,
        activeDocumentId: state.activeDocumentId,
        activeThreadId: state.activeThreadId,
        mobileActivePanel: state.mobileActivePanel,
        // threadFocusVersion is ephemeral and not persisted

        // rightPanelState excluded - always resets to 'documents' on page load
      }),
    }
  )
)
