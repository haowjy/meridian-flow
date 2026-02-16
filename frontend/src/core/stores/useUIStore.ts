import { create } from "zustand";
import { persist } from "zustand/middleware";
import { makeLogger } from "@/core/lib/logger";

const logger = makeLogger("ui-store");

/**
 * Represents the current view mode of the right panel.
 * - 'documents': Shows document tree/file explorer
 * - 'editor': Shows document editor
 * - null: No specific mode (initial state)
 */
export type RightPanelState = "documents" | "editor" | null;

/**
 * Project list sort options.
 */
export type ProjectSortOrder =
  | "updated"
  | "name-asc"
  | "name-desc"
  | "created-newest"
  | "created-oldest";

/**
 * User's explicit panel override choice.
 * - 'expanded': User explicitly expanded the panel
 * - 'collapsed': User explicitly collapsed the panel
 * - null: No override, follow auto behavior (collapsed if not ready, expanded if ready)
 */
export type PanelUserOverride = "expanded" | "collapsed" | null;

/**
 * Mobile tab type for bottom navigation.
 * State-driven (not URL-driven) to preserve scroll position and component state.
 */
export type MobileTab = "threads" | "chat" | "documents" | "projectSettings";

export interface PendingThreadReference {
  documentId: string;
  refType: "document";
  displayName: string;
  documentPath?: string;
}

/**
 * UI state store for workspace layout and panel management.
 *
 * Persisted to localStorage: leftPanelUserOverride, rightPanelUserOverride, activeDocumentId, activeThreadId, documentTreeCollapsed.
 * Not persisted (session-scoped): rightPanelState, threadFocusVersion, leftPanelReady, rightPanelReady.
 *
 * ## Panel Collapse State Machine
 *
 * Three possible states for each panel's user override:
 * 1. **null** (default): Follow auto behavior
 *    - Collapsed when !ready (data not loaded yet)
 *    - Expanded when ready (data loaded successfully)
 * 2. **'collapsed'**: User explicitly collapsed the panel
 *    - Stay collapsed regardless of ready state
 *    - Persists across sessions
 * 3. **'expanded'**: User explicitly expanded the panel
 *    - Stay expanded regardless of ready state
 *    - Persists across sessions
 *
 * ## State Transitions
 *
 * **Auto behavior (userOverride = null):**
 * - Initial: collapsed (ready = false)
 * - After data loads: expanded (ready = true)
 *
 * **User manually collapses:**
 * - Sets userOverride = 'collapsed'
 * - Panel stays collapsed even after data loads
 *
 * **User manually expands:**
 * - Sets userOverride = 'expanded'
 * - Panel stays expanded even during loading
 *
 * **Reset to auto behavior:**
 * - Set userOverride = null (not currently implemented in UI)
 * - Returns to auto collapse/expand based on ready state
 *
 * ## Implementation Notes
 *
 * - Use `selectEffectiveLeftCollapsed` / `selectEffectiveRightCollapsed` selectors
 *   to compute the final collapsed state (considers both ready + override)
 * - User override takes precedence over auto behavior
 * - Ready state is session-scoped, override is persisted
 * - On project switch: reset ready state but preserve user override
 */
interface UIStore {
  /**
   * Whether left panel data is ready (thread list loaded).
   * Set by data loaders, NOT persisted.
   * @default false
   */
  leftPanelReady: boolean;

  /**
   * Whether right panel data is ready (document tree loaded).
   * Set by data loaders, NOT persisted.
   * @default false
   */
  rightPanelReady: boolean;

  /**
   * User's explicit override for left panel visibility.
   * Takes precedence over auto behavior (ready state).
   * Persisted across sessions - user's collapse/expand choice is remembered.
   * @default null (follow auto behavior: collapsed until ready, then expanded)
   */
  leftPanelUserOverride: PanelUserOverride;

  /**
   * User's explicit override for right panel visibility.
   * Takes precedence over auto behavior (ready state).
   * Persisted across sessions - user's collapse/expand choice is remembered.
   * @default null (follow auto behavior: collapsed until ready, then expanded)
   */
  rightPanelUserOverride: PanelUserOverride;

  /**
   * Determines right panel content: 'documents' (tree view) or 'editor'.
   * NOT persisted - always resets to 'documents' on page load.
   * Use panelHelpers.openDocument() to coordinate opening editor.
   * @default 'documents'
   */
  rightPanelState: RightPanelState;

  /**
   * ID of currently active document (for highlighting in tree + editor).
   * Persisted across sessions.
   * Null if no document is active.
   * Mutually exclusive with activeSkillId.
   * @default null
   */
  activeDocumentId: string | null;

  /**
   * ID of currently active skill (for highlighting in tree + editor).
   * Persisted across sessions.
   * Null if no skill is active.
   * Mutually exclusive with activeDocumentId.
   * @default null
   */
  activeSkillId: string | null;

  /**
   * ID of currently active thread (for highlighting in thread list).
   * Persisted across sessions.
   * Null if no thread is active.
   * @default null
   */
  activeThreadId: string | null;

  /**
   * Monotonic counter used to drive thread input auto-focus.
   * Incremented when "New Thread" is pressed so the input refocuses even if
   * the activeThreadId does not change (e.g., cold-start state).
   */
  threadFocusVersion: number;

  /**
   * Current sort order for the projects list.
   * Persisted across sessions.
   * @default 'updated' (most recently updated first)
   */
  projectSortOrder: ProjectSortOrder;

  /**
   * Current search query for filtering projects.
   * NOT persisted (ephemeral).
   * @default ''
   */
  projectSearchQuery: string;

  /**
   * Whether the document tree sidebar is collapsed when viewing editor.
   * Controls tree visibility in split layout (tree + editor side-by-side).
   * Persisted across sessions.
   * @default false (tree visible by default)
   */
  documentTreeCollapsed: boolean;

  /**
   * Current view of left panel in workspace.
   * 'chat': Show active thread view
   * 'threads': Show thread list
   * 'projectSettings': Show project settings panel
   * Persisted across sessions.
   * @default 'chat'
   */
  leftPanelView: "chat" | "threads" | "projectSettings";

  /**
   * Active tab for mobile bottom navigation.
   * State-driven (not URL-driven) to preserve scroll position and component state.
   * NOT persisted - derives initial value from URL on page load.
   * @default 'chat'
   */
  mobileActiveTab: MobileTab;

  /**
   * ID of a recently created folder (for temporary highlight animation).
   * Cleared automatically after a brief delay.
   * NOT persisted.
   * @default null
   */
  recentlyCreatedFolderId: string | null;

  /**
   * Set of thinking group IDs that the user has explicitly expanded.
   * Thinking groups default to collapsed, but user's expand choice is remembered.
   * NOT persisted (session-scoped - doesn't make sense to persist across refreshes).
   * @default new Set()
   */
  expandedThinkingGroups: Set<string>;

  /**
   * Set of tool group IDs that the user has explicitly expanded.
   * Tool groups default to collapsed, but user's expand choice is remembered.
   * NOT persisted (session-scoped - doesn't make sense to persist across refreshes).
   * @default new Set()
   */
  expandedToolGroups: Set<string>;

  /**
   * Whether the version history panel is visible for the active document.
   * NOT persisted (session-scoped).
   * @default false
   */
  showVersionHistory: boolean;

  /**
   * References queued by non-composer UI actions (e.g., tree context menus).
   * TurnInput consumes and clears this queue, appending each item to the draft.
   * NOT persisted.
   * @default []
   */
  pendingThreadReferences: PendingThreadReference[];

  /**
   * Timestamp of last @ reference usage (for conditional hint display).
   * When null or >7 days stale, composer shows "@ for reference" hint.
   * Persisted across sessions.
   * @default null
   */
  lastAtReferenceUsed: number | null;

  /**
   * Toggles left panel collapsed/expanded state (sets user override)
   */
  toggleLeftPanel: () => void;

  /** Toggles right panel collapsed/expanded state (sets user override) */
  toggleRightPanel: () => void;

  /** Sets left panel ready state (called by data loaders) */
  setLeftPanelReady: (ready: boolean) => void;

  /** Sets right panel ready state (called by data loaders) */
  setRightPanelReady: (ready: boolean) => void;

  /** Explicitly sets left panel user override (persisted) */
  setLeftPanelUserOverride: (override: PanelUserOverride) => void;

  /** Explicitly sets right panel user override (persisted) */
  setRightPanelUserOverride: (override: PanelUserOverride) => void;

  /**
   * Sets right panel view mode.
   * Use panelHelpers.openDocument() for opening documents (navigates URL).
   * Call directly with 'documents' to show tree view without navigating.
   */
  setRightPanelState: (state: RightPanelState) => void;

  /** Directly sets right panel collapsed state (prefer toggleRightPanel) */
  setRightPanelCollapsed: (collapsed: boolean) => void;

  /**
   * Sets active document ID (clears activeSkillId for mutual exclusivity).
   * Use panelHelpers.openDocument() to also open editor and expand panel.
   */
  setActiveDocument: (id: string | null) => void;

  /**
   * Sets active skill ID (clears activeDocumentId for mutual exclusivity).
   * Use panelHelpers.openSkill() to also open editor and expand panel.
   */
  setActiveSkill: (id: string | null) => void;

  /**
   * Sets active thread ID.
   * Use panelHelpers.switchThread() for semantic clarity.
   */
  setActiveThread: (id: string | null) => void;

  /** Bumps threadFocusVersion to request thread input focus. */
  bumpThreadFocusVersion: () => void;

  /** Sets the project list sort order (persisted) */
  setProjectSortOrder: (order: ProjectSortOrder) => void;

  /** Sets the project search query (not persisted) */
  setProjectSearchQuery: (query: string) => void;

  /** Toggles document tree sidebar collapsed/expanded state */
  toggleDocumentTree: () => void;

  /** Sets document tree collapsed state (persisted) */
  setDocumentTreeCollapsed: (collapsed: boolean) => void;

  /** Sets left panel view (chat, threads, or projectSettings) */
  setLeftPanelView: (view: "chat" | "threads" | "projectSettings") => void;

  /** Sets mobile active tab (threads, chat, or documents) */
  setMobileActiveTab: (tab: MobileTab) => void;

  /** Sets recently created folder ID (for highlight animation) */
  setRecentlyCreatedFolderId: (id: string | null) => void;

  /** Toggle thinking group expanded state */
  toggleThinkingGroup: (groupId: string) => void;

  /** Check if a thinking group is expanded */
  isThinkingGroupExpanded: (groupId: string) => boolean;

  /** Clear all expanded thinking groups (e.g., on thread change) */
  clearExpandedThinkingGroups: () => void;

  /** Toggle tool group expanded state */
  toggleToolGroup: (groupId: string) => void;

  /** Check if a tool group is expanded */
  isToolGroupExpanded: (groupId: string) => boolean;

  /** Clear all expanded tool groups (e.g., on thread change) */
  clearExpandedToolGroups: () => void;

  /** Queue references for insertion into the active thread composer. */
  queueThreadReferences: (refs: PendingThreadReference[]) => void;

  /** Clear queued references after composer consumes them. */
  clearPendingThreadReferences: () => void;

  /** Toggle version history panel visibility. */
  toggleVersionHistory: () => void;

  /** Set version history panel visibility. */
  setShowVersionHistory: (show: boolean) => void;

  /** Record that the user selected an @ reference (persisted timestamp). */
  recordAtReferenceUsage: () => void;
}

/**
 * Selector: Compute effective left panel collapsed state.
 * User override takes precedence, otherwise auto-collapse if not ready.
 */
export const selectEffectiveLeftCollapsed = (s: UIStore): boolean =>
  s.leftPanelUserOverride !== null
    ? s.leftPanelUserOverride === "collapsed"
    : !s.leftPanelReady; // Auto: collapsed if not ready

/**
 * Selector: Compute effective right panel collapsed state.
 * User override takes precedence, otherwise auto-collapse if not ready.
 */
export const selectEffectiveRightCollapsed = (s: UIStore): boolean =>
  s.rightPanelUserOverride !== null
    ? s.rightPanelUserOverride === "collapsed"
    : !s.rightPanelReady; // Auto: collapsed if not ready

export const useUIStore = create<UIStore>()(
  persist(
    (set, get) => ({
      leftPanelReady: false,
      rightPanelReady: false,
      leftPanelUserOverride: null,
      rightPanelUserOverride: null,
      rightPanelState: "documents",
      activeDocumentId: null,
      activeSkillId: null,
      activeThreadId: null,
      threadFocusVersion: 0,
      projectSortOrder: "updated",
      projectSearchQuery: "",
      documentTreeCollapsed: false,
      leftPanelView: "chat",
      mobileActiveTab: "chat",
      recentlyCreatedFolderId: null,
      expandedThinkingGroups: new Set<string>(),
      expandedToolGroups: new Set<string>(),
      showVersionHistory: false,
      pendingThreadReferences: [],
      lastAtReferenceUsed: null,

      toggleLeftPanel: () => {
        const currentlyCollapsed = selectEffectiveLeftCollapsed(get());
        // Toggle sets user override to opposite of current effective state
        set({
          leftPanelUserOverride: currentlyCollapsed ? "expanded" : "collapsed",
        });
      },
      toggleRightPanel: () => {
        const currentlyCollapsed = selectEffectiveRightCollapsed(get());
        // Toggle sets user override to opposite of current effective state
        set({
          rightPanelUserOverride: currentlyCollapsed ? "expanded" : "collapsed",
        });
      },
      setLeftPanelReady: (ready) => set({ leftPanelReady: ready }),
      setRightPanelReady: (ready) => set({ rightPanelReady: ready }),
      setLeftPanelUserOverride: (override) =>
        set({ leftPanelUserOverride: override }),
      setRightPanelUserOverride: (override) =>
        set({ rightPanelUserOverride: override }),
      setRightPanelState: (state) => {
        const stack =
          new Error().stack?.split("\n").slice(2, 6).join("\n") || "no stack";
        logger.debug("[SKILL-DEEPLINK] setRightPanelState called", {
          state,
          prevState: get().rightPanelState,
          stack,
        });
        set({ rightPanelState: state });
      },
      // Sets user override to force panel expanded/collapsed state
      // Used by URL navigation to expand panel when opening documents/skills
      setRightPanelCollapsed: (collapsed) =>
        set({ rightPanelUserOverride: collapsed ? "collapsed" : "expanded" }),
      setActiveDocument: (id) => {
        const stack =
          new Error().stack?.split("\n").slice(2, 6).join("\n") || "no stack";
        logger.debug("[SKILL-DEEPLINK] setActiveDocument called", {
          id,
          prevId: get().activeDocumentId,
          stack,
        });
        set({ activeDocumentId: id, activeSkillId: null, showVersionHistory: false });
      },
      setActiveSkill: (id) => {
        const stack =
          new Error().stack?.split("\n").slice(2, 6).join("\n") || "no stack";
        logger.debug("[SKILL-DEEPLINK] setActiveSkill called", {
          id,
          prevId: get().activeSkillId,
          stack,
        });
        set({ activeSkillId: id, activeDocumentId: null });
      },
      setActiveThread: (id) => set({ activeThreadId: id }),
      bumpThreadFocusVersion: () =>
        set((state) => ({ threadFocusVersion: state.threadFocusVersion + 1 })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
      setProjectSearchQuery: (query) => set({ projectSearchQuery: query }),
      toggleDocumentTree: () =>
        set((state) => ({
          documentTreeCollapsed: !state.documentTreeCollapsed,
        })),
      setDocumentTreeCollapsed: (collapsed) =>
        set({ documentTreeCollapsed: collapsed }),
      setLeftPanelView: (view) => set({ leftPanelView: view }),
      setMobileActiveTab: (tab) => set({ mobileActiveTab: tab }),
      setRecentlyCreatedFolderId: (id) => set({ recentlyCreatedFolderId: id }),
      toggleThinkingGroup: (groupId) =>
        set((state) => {
          const newSet = new Set(state.expandedThinkingGroups);
          if (newSet.has(groupId)) {
            newSet.delete(groupId);
          } else {
            newSet.add(groupId);
          }
          return { expandedThinkingGroups: newSet };
        }),
      isThinkingGroupExpanded: (groupId) =>
        get().expandedThinkingGroups.has(groupId),
      clearExpandedThinkingGroups: () =>
        set({ expandedThinkingGroups: new Set<string>() }),
      toggleToolGroup: (groupId) =>
        set((state) => {
          const newSet = new Set(state.expandedToolGroups);
          if (newSet.has(groupId)) {
            newSet.delete(groupId);
          } else {
            newSet.add(groupId);
          }
          return { expandedToolGroups: newSet };
        }),
      isToolGroupExpanded: (groupId) => get().expandedToolGroups.has(groupId),
      clearExpandedToolGroups: () =>
        set({ expandedToolGroups: new Set<string>() }),
      queueThreadReferences: (refs) =>
        set((state) => {
          if (refs.length === 0) return state;

          const seen = new Set(
            state.pendingThreadReferences.map((ref) => ref.documentId),
          );
          const merged = [...state.pendingThreadReferences];

          for (const ref of refs) {
            if (!seen.has(ref.documentId)) {
              seen.add(ref.documentId);
              merged.push(ref);
            }
          }

          return { pendingThreadReferences: merged };
        }),
      clearPendingThreadReferences: () => set({ pendingThreadReferences: [] }),
      toggleVersionHistory: () =>
        set((state) => ({ showVersionHistory: !state.showVersionHistory })),
      setShowVersionHistory: (show) => set({ showVersionHistory: show }),
      recordAtReferenceUsage: () => set({ lastAtReferenceUsed: Date.now() }),
    }),
    {
      name: "ui-store",
      version: 6, // Bumped from 5 to add lastAtReferenceUsed
      partialize: (state) => ({
        // Persist user's explicit panel override choice (expanded/collapsed/null)
        leftPanelUserOverride: state.leftPanelUserOverride,
        rightPanelUserOverride: state.rightPanelUserOverride,
        activeDocumentId: state.activeDocumentId,
        activeSkillId: state.activeSkillId,
        activeThreadId: state.activeThreadId,
        // Projects page preferences
        projectSortOrder: state.projectSortOrder,
        // Document tree state
        documentTreeCollapsed: state.documentTreeCollapsed,
        // Workspace state
        leftPanelView: state.leftPanelView,
        // Composer hint state
        lastAtReferenceUsed: state.lastAtReferenceUsed,
        // NOT persisted: leftPanelReady, rightPanelReady (session-scoped, set by data loaders)
        // NOT persisted: threadFocusVersion, rightPanelState, projectSearchQuery (ephemeral)
        // REMOVED in v4: mobileActivePanel (new mobile layout uses local state)
      }),
      // Migrate from older versions
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;

        // v1 → v2: Convert boolean collapsed to override system
        if (version < 2) {
          if (state.leftPanelCollapsed !== undefined) {
            state.leftPanelUserOverride = state.leftPanelCollapsed
              ? "collapsed"
              : "expanded";
            delete state.leftPanelCollapsed;
          }
          if (state.rightPanelCollapsed !== undefined) {
            state.rightPanelUserOverride = state.rightPanelCollapsed
              ? "collapsed"
              : "expanded";
            delete state.rightPanelCollapsed;
          }
        }

        // v3 → v4: Remove mobileActivePanel
        if (version < 4) {
          delete state.mobileActivePanel;
        }

        return state;
      },
    },
  ),
);
