import type { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

/**
 * Minimal interface for collab session cleanup. TabManager only needs
 * the destroy method -- it doesn't depend on the full CollabSession type
 * to avoid coupling tab management to Yjs internals.
 */
export interface TabCollabHandle {
  destroy: () => void
}

/**
 * Represents a single open document tab.
 *
 * Tabs can be in three states:
 * - **Live**: EditorView + DOM exist in the LRU cache (instant CSS show/hide)
 * - **Evicted**: EditorView destroyed, state + scroll cached (fast ~100ms restore)
 * - **Closed**: Removed entirely from the tab list
 *
 * The collab session is managed externally (created by the consumer) but
 * destroyed automatically by TabManager on eviction and close.
 */
export interface TabEntry {
  documentId: string
  documentName: string
  isModified: boolean

  // Live state (while in LRU cache)
  editorView: EditorView | null
  containerEl: HTMLDivElement | null

  // Cached state (after eviction)
  cachedState: EditorState | null
  scrollSnapshot: { scrollTop: number; scrollLeft: number } | null

  // Collab session (Phase 6). Set externally via setCollabSession().
  // Destroyed automatically on tab evict/close.
  collabSession: TabCollabHandle | null
}

export type TabInfo = Pick<TabEntry, "documentId" | "documentName" | "isModified">

/** Snapshot of tab state for React consumption */
export interface TabSnapshot {
  tabs: TabInfo[]
  activeTabId: string | null
}

export interface TabManagerOptions {
  /** Maximum number of live EditorViews. Default: 6 */
  maxLive?: number
  /** Called when a new EditorView needs to be created for a document */
  createEditorView: (
    documentId: string,
    container: HTMLDivElement,
    cachedState?: EditorState | null,
  ) => EditorView
}

/**
 * Manages multiple EditorView instances using the VS Code model: one
 * EditorView per open document, CSS show/hide for instant switching.
 *
 * Keeps up to `maxLive` (default 6) views alive. When exceeded, the
 * least recently used view is evicted: its EditorView is destroyed
 * and EditorState + scroll position are cached for fast re-mount.
 *
 * The active tab is never evicted.
 *
 * Includes built-in snapshot + subscription for useSyncExternalStore.
 */
export class TabManager {
  private tabs = new Map<string, TabEntry>()
  private lruOrder: string[] = [] // most recent first
  private readonly maxLive: number
  private activeTabId: string | null = null

  private createEditorViewFn: TabManagerOptions["createEditorView"]

  // Built-in subscription system for useSyncExternalStore
  private listeners = new Set<() => void>()
  private snapshot: TabSnapshot = { tabs: [], activeTabId: null }

  /** Parent container where all tab containers are appended */
  private hostEl: HTMLDivElement | null = null

  constructor(options: TabManagerOptions) {
    this.maxLive = options.maxLive ?? 6
    this.createEditorViewFn = options.createEditorView
  }

  /** Update the createEditorView callback (for React hook re-render sync) */
  updateCreateEditorView(
    fn: TabManagerOptions["createEditorView"],
  ): void {
    this.createEditorViewFn = fn
  }

  // --- Subscription API (for useSyncExternalStore) ---

  /** Subscribe to snapshot changes. Returns unsubscribe function. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Get the current snapshot (immutable between changes) */
  getSnapshot = (): TabSnapshot => {
    return this.snapshot
  }

  /** Notify all subscribers that the snapshot has changed */
  private emitChange(): void {
    this.snapshot = {
      tabs: this.getTabs(),
      activeTabId: this.activeTabId,
    }
    for (const listener of this.listeners) {
      listener()
    }
  }

  /** Set the host element where tab containers are mounted */
  setHost(el: HTMLDivElement | null): void {
    this.hostEl = el
  }

  /** Get the currently active tab ID */
  getActiveTabId(): string | null {
    return this.activeTabId
  }

  /** Get a snapshot of all open tabs for rendering */
  getTabs(): TabInfo[] {
    return Array.from(this.tabs.values()).map((t) => ({
      documentId: t.documentId,
      documentName: t.documentName,
      isModified: t.isModified,
    }))
  }

  /** Get the EditorView for a specific tab (if live) */
  getEditorView(documentId: string): EditorView | null {
    return this.tabs.get(documentId)?.editorView ?? null
  }

  /** Get the active tab's EditorView */
  getActiveEditorView(): EditorView | null {
    if (!this.activeTabId) return null
    return this.getEditorView(this.activeTabId)
  }

  /** Check if a document is already open */
  hasTab(documentId: string): boolean {
    return this.tabs.has(documentId)
  }

  /**
   * Open a new tab for a document, or switch to it if already open.
   * Returns the EditorView for the tab.
   */
  openTab(documentId: string, documentName: string): EditorView | null {
    if (this.tabs.has(documentId)) {
      return this.switchTo(documentId)
    }

    // Create new tab entry
    const entry: TabEntry = {
      documentId,
      documentName,
      isModified: false,
      editorView: null,
      containerEl: null,
      cachedState: null,
      scrollSnapshot: null,
      collabSession: null,
    }

    this.tabs.set(documentId, entry)
    this.mountTab(entry)
    return this.switchTo(documentId)
  }

  /**
   * Switch to an existing tab. Uses CSS display for live tabs,
   * restores from cached state for evicted tabs.
   */
  switchTo(documentId: string): EditorView | null {
    const tab = this.tabs.get(documentId)
    if (!tab) return null

    // Hide current active tab
    if (this.activeTabId && this.activeTabId !== documentId) {
      const current = this.tabs.get(this.activeTabId)
      if (current?.containerEl) {
        current.containerEl.style.display = "none"
      }
    }

    this.activeTabId = documentId
    this.touchLRU(documentId)

    if (tab.editorView && tab.containerEl) {
      // Live tab: just show it
      tab.containerEl.style.display = "block"
      // requestMeasure recalculates viewport after display:none -> block
      tab.editorView.requestMeasure()
      tab.editorView.focus()
    } else if (tab.cachedState) {
      // Evicted tab: restore from cached state
      this.restoreTab(tab)
      this.evictIfNeeded()
    } else if (!tab.editorView) {
      // New tab: needs initial mount
      this.mountTab(tab)
    }

    this.emitChange()
    return tab.editorView
  }

  /**
   * Close a tab and destroy its resources.
   * If the closed tab was active, activates the next tab.
   */
  closeTab(documentId: string): void {
    const tab = this.tabs.get(documentId)
    if (!tab) return

    // Destroy collab session first (before EditorView, since yCollab
    // extensions are attached to the view)
    if (tab.collabSession) {
      tab.collabSession.destroy()
      tab.collabSession = null
    }

    // Destroy live resources
    if (tab.editorView) {
      tab.editorView.destroy()
      tab.editorView = null
    }
    if (tab.containerEl) {
      tab.containerEl.remove()
      tab.containerEl = null
    }

    // Remove from LRU
    this.lruOrder = this.lruOrder.filter((id) => id !== documentId)
    this.tabs.delete(documentId)

    // If we closed the active tab, switch to the most recent remaining
    if (this.activeTabId === documentId) {
      this.activeTabId = null
      if (this.lruOrder.length > 0) {
        this.switchTo(this.lruOrder[0])
        return // switchTo already calls onStateChange
      }
    }

    this.emitChange()
  }

  /** Mark a tab as modified or clean */
  setModified(documentId: string, modified: boolean): void {
    const tab = this.tabs.get(documentId)
    if (!tab || tab.isModified === modified) return
    tab.isModified = modified
    this.emitChange()
  }

  /** Set the collab session for a tab. TabManager auto-destroys it on evict/close. */
  setCollabSession(documentId: string, session: TabCollabHandle | null): void {
    const tab = this.tabs.get(documentId)
    if (!tab) return
    // Destroy existing session before replacing
    if (tab.collabSession && tab.collabSession !== session) {
      tab.collabSession.destroy()
    }
    tab.collabSession = session
  }

  /** Get the collab session for a tab (if any). */
  getCollabSession(documentId: string): TabCollabHandle | null {
    return this.tabs.get(documentId)?.collabSession ?? null
  }

  /** Rename a tab's document */
  renameTab(documentId: string, newName: string): void {
    const tab = this.tabs.get(documentId)
    if (!tab) return
    tab.documentName = newName
    this.emitChange()
  }

  /** Destroy all tabs and clean up */
  destroy(): void {
    for (const tab of this.tabs.values()) {
      if (tab.collabSession) {
        tab.collabSession.destroy()
        tab.collabSession = null
      }
      if (tab.editorView) {
        tab.editorView.destroy()
      }
      if (tab.containerEl) {
        tab.containerEl.remove()
      }
    }
    this.tabs.clear()
    this.lruOrder = []
    this.activeTabId = null
  }

  // --- Private ---

  /** Create and mount a new EditorView for a tab */
  private mountTab(tab: TabEntry): void {
    if (!this.hostEl) return

    const container = document.createElement("div")
    container.className = "editor-tab-container h-full min-h-0"
    container.style.display = "none"
    container.dataset.documentId = tab.documentId

    this.hostEl.appendChild(container)
    tab.containerEl = container
    tab.editorView = this.createEditorViewFn(tab.documentId, container, null)
  }

  /** Restore an evicted tab from cached state */
  private restoreTab(tab: TabEntry): void {
    if (!this.hostEl || !tab.cachedState) return

    const container = document.createElement("div")
    container.className = "editor-tab-container h-full min-h-0"
    container.dataset.documentId = tab.documentId

    this.hostEl.appendChild(container)
    tab.containerEl = container
    tab.editorView = this.createEditorViewFn(
      tab.documentId,
      container,
      tab.cachedState,
    )

    // Restore scroll position via requestMeasure (runs after CM6 has
    // laid out the DOM, ensuring scrollTop/scrollLeft apply correctly)
    if (tab.scrollSnapshot) {
      const { scrollTop, scrollLeft } = tab.scrollSnapshot
      tab.editorView.requestMeasure({
        read() {},
        write(_measure, view) {
          view.scrollDOM.scrollTop = scrollTop
          view.scrollDOM.scrollLeft = scrollLeft
        },
      })
    }

    tab.cachedState = null
    tab.scrollSnapshot = null
  }

  /** Move a document to the front of the LRU list */
  private touchLRU(documentId: string): void {
    this.lruOrder = this.lruOrder.filter((id) => id !== documentId)
    this.lruOrder.unshift(documentId)
    this.evictIfNeeded()
  }

  /**
   * Evict least recently used tabs when LRU exceeds maxLive.
   * The active tab is never evicted.
   */
  private evictIfNeeded(): void {
    // Count live (non-evicted) tabs
    const liveCount = this.lruOrder.filter((id) => {
      const tab = this.tabs.get(id)
      return tab?.editorView != null
    }).length

    if (liveCount <= this.maxLive) return

    // Find eviction candidates: live tabs that are NOT the active tab,
    // ordered from least recently used (end of array) to most recent
    const candidates = [...this.lruOrder]
      .reverse()
      .filter((id) => id !== this.activeTabId && this.tabs.get(id)?.editorView != null)

    let toEvict = liveCount - this.maxLive
    for (const evictId of candidates) {
      if (toEvict <= 0) break

      const tab = this.tabs.get(evictId)
      if (!tab?.editorView) continue

      // Destroy collab session before EditorView (yCollab extensions are
      // attached to the view). On restore, a fresh session is created and
      // synced from IndexedDB + WebSocket.
      if (tab.collabSession) {
        tab.collabSession.destroy()
        tab.collabSession = null
      }

      // Save state before destroying
      tab.cachedState = tab.editorView.state
      tab.scrollSnapshot = {
        scrollTop: tab.editorView.scrollDOM.scrollTop,
        scrollLeft: tab.editorView.scrollDOM.scrollLeft,
      }

      tab.editorView.destroy()
      tab.editorView = null
      tab.containerEl?.remove()
      tab.containerEl = null

      toEvict--
    }
  }
}
