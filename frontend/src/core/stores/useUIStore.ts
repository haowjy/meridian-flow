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
 * User's explicit panel override choice.
 * - 'expanded': User explicitly expanded the panel
 * - 'collapsed': User explicitly collapsed the panel
 * - null: No override, follow auto behavior (collapsed if not ready, expanded if ready)
 */
export type PanelUserOverride = 'expanded' | 'collapsed' | null

/**
 * UI state store for workspace layout and panel management.
 *
 * Persisted to localStorage: leftPanelUserOverride, rightPanelUserOverride, activeDocumentId, activeThreadId, mobileActivePanel.
 * Not persisted (session-scoped): rightPanelState, threadFocusVersion, leftPanelReady, rightPanelReady.
 *
 * Panel visibility logic:
 * - Use selectEffectiveLeftCollapsed/selectEffectiveRightCollapsed selectors
 * - User override takes precedence over auto behavior (and persists across sessions)
 * - Auto (when override is null): collapsed if data not ready, expanded when ready
 */
interface UIStore {
  /**
   * Whether left panel data is ready (thread list loaded).
   * Set by data loaders, NOT persisted.
   * @default false
   */
  leftPanelReady: boolean

  /**
   * Whether right panel data is ready (document tree loaded).
   * Set by data loaders, NOT persisted.
   * @default false
   */
  rightPanelReady: boolean

  /**
   * User's explicit override for left panel visibility.
   * Takes precedence over auto behavior (ready state).
   * Persisted across sessions - user's collapse/expand choice is remembered.
   * @default null (follow auto behavior: collapsed until ready, then expanded)
   */
  leftPanelUserOverride: PanelUserOverride

  /**
   * User's explicit override for right panel visibility.
   * Takes precedence over auto behavior (ready state).
   * Persisted across sessions - user's collapse/expand choice is remembered.
   * @default null (follow auto behavior: collapsed until ready, then expanded)
   */
  rightPanelUserOverride: PanelUserOverride

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

  /** Toggles left panel collapsed/expanded state (sets user override) */
  toggleLeftPanel: () => void

  /** Toggles right panel collapsed/expanded state (sets user override) */
  toggleRightPanel: () => void

  /** Sets left panel ready state (called by data loaders) */
  setLeftPanelReady: (ready: boolean) => void

  /** Sets right panel ready state (called by data loaders) */
  setRightPanelReady: (ready: boolean) => void

  /** Explicitly sets left panel user override (persisted) */
  setLeftPanelUserOverride: (override: PanelUserOverride) => void

  /** Explicitly sets right panel user override (persisted) */
  setRightPanelUserOverride: (override: PanelUserOverride) => void

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

/**
 * Selector: Compute effective left panel collapsed state.
 * User override takes precedence, otherwise auto-collapse if not ready.
 */
export const selectEffectiveLeftCollapsed = (s: UIStore): boolean =>
  s.leftPanelUserOverride !== null
    ? s.leftPanelUserOverride === 'collapsed'
    : !s.leftPanelReady // Auto: collapsed if not ready

/**
 * Selector: Compute effective right panel collapsed state.
 * User override takes precedence, otherwise auto-collapse if not ready.
 */
export const selectEffectiveRightCollapsed = (s: UIStore): boolean =>
  s.rightPanelUserOverride !== null
    ? s.rightPanelUserOverride === 'collapsed'
    : !s.rightPanelReady // Auto: collapsed if not ready

export const useUIStore = create<UIStore>()(
  persist(
    (set, get) => ({
      leftPanelReady: false,
      rightPanelReady: false,
      leftPanelUserOverride: null,
      rightPanelUserOverride: null,
      rightPanelState: 'documents',
      activeDocumentId: null,
      activeThreadId: null,
      threadFocusVersion: 0,
      mobileActivePanel: 'activeThread',

      toggleLeftPanel: () => {
        const currentlyCollapsed = selectEffectiveLeftCollapsed(get())
        // Toggle sets user override to opposite of current effective state
        set({ leftPanelUserOverride: currentlyCollapsed ? 'expanded' : 'collapsed' })
      },
      toggleRightPanel: () => {
        const currentlyCollapsed = selectEffectiveRightCollapsed(get())
        // Toggle sets user override to opposite of current effective state
        set({ rightPanelUserOverride: currentlyCollapsed ? 'expanded' : 'collapsed' })
      },
      setLeftPanelReady: (ready) => set({ leftPanelReady: ready }),
      setRightPanelReady: (ready) => set({ rightPanelReady: ready }),
      setLeftPanelUserOverride: (override) => set({ leftPanelUserOverride: override }),
      setRightPanelUserOverride: (override) => set({ rightPanelUserOverride: override }),
      setRightPanelState: (state) =>
        set({ rightPanelState: state }),
      // Sets user override to force panel expanded/collapsed state
      // Used by URL navigation to expand panel when opening documents
      setRightPanelCollapsed: (collapsed) =>
        set({ rightPanelUserOverride: collapsed ? 'collapsed' : 'expanded' }),
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
      version: 2,
      partialize: (state) => ({
        // Persist user's explicit panel override choice (expanded/collapsed/null)
        leftPanelUserOverride: state.leftPanelUserOverride,
        rightPanelUserOverride: state.rightPanelUserOverride,
        activeDocumentId: state.activeDocumentId,
        activeThreadId: state.activeThreadId,
        mobileActivePanel: state.mobileActivePanel,
        // NOT persisted: leftPanelReady, rightPanelReady (session-scoped, set by data loaders)
        // NOT persisted: threadFocusVersion, rightPanelState (ephemeral)
      }),
      // Migrate from v1 (boolean collapsed) to v2 (user override system)
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>
        if (version < 2) {
          // Convert old boolean collapsed fields to new override system
          if (state.leftPanelCollapsed !== undefined) {
            state.leftPanelUserOverride = state.leftPanelCollapsed ? 'collapsed' : 'expanded'
            delete state.leftPanelCollapsed
          }
          if (state.rightPanelCollapsed !== undefined) {
            state.rightPanelUserOverride = state.rightPanelCollapsed ? 'collapsed' : 'expanded'
            delete state.rightPanelCollapsed
          }
        }
        return state
      },
    }
  )
)
