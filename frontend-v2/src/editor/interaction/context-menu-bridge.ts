import type { ChangeDesc } from "@codemirror/state"

/**
 * Menu element types. HR is intentionally excluded -- too simple for a
 * context menu. HR widgets use .md-hr-wrapper (not .md-widget-wrapper)
 * and are skipped by the contextmenu handler.
 */
export type MenuElementType = "link" | "image" | "code-block" | "mermaid"

/**
 * State of the context menu, or null when closed.
 */
export type MenuState = {
  type: MenuElementType
  /** Document position of the element (at menu open time) */
  pos: number
  /** Screen coordinates for menu placement */
  coords: { x: number; y: number }
  /** Element-specific data (href, src, alt, language...) */
  meta: Record<string, string>
} | null

type Listener = () => void

/**
 * CM6-to-React bridge for the context menu. CM6 writes state via open/close;
 * React reads via useSyncExternalStore (subscribe + getSnapshot).
 *
 * ChangeDesc tracking: a ViewPlugin calls trackChanges() on each update while
 * the menu is open. getMappedPos() maps the original pos through accumulated
 * changes so menu actions hit the correct document position even after remote
 * Yjs edits arrive between menu open and action execution.
 */
class ContextMenuBridge {
  private menuState: MenuState = null
  private pendingChanges: ChangeDesc[] = []
  private listeners = new Set<Listener>()

  /** Open the context menu. Resets change tracking. */
  open(state: NonNullable<MenuState>): void {
    this.menuState = state
    this.pendingChanges = []
    this.notify()
  }

  /** Close the context menu. Clears all state. */
  close(): void {
    this.menuState = null
    this.pendingChanges = []
    this.notify()
  }

  /**
   * Called by a ViewPlugin on each update while the menu is open.
   * Accumulates ChangeDesc for position mapping.
   */
  trackChanges(changes: ChangeDesc): void {
    if (this.menuState) {
      this.pendingChanges.push(changes)
    }
  }

  /**
   * Map the original pos through all accumulated changes.
   * Clamps to docLength to prevent out-of-bounds access.
   */
  getMappedPos(docLength: number): number {
    if (!this.menuState) throw new Error("No menu open")
    let pos = this.menuState.pos
    for (const changes of this.pendingChanges) {
      pos = changes.mapPos(pos)
    }
    return Math.min(pos, docLength)
  }

  /** Get the current menu state (null when closed). */
  getState(): MenuState {
    return this.menuState
  }

  // --- useSyncExternalStore API ---

  /** Subscribe to state changes. Returns unsubscribe function. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Return the current snapshot (stable reference when state hasn't changed). */
  getSnapshot = (): MenuState => {
    return this.menuState
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener()
    }
  }
}

/** Singleton bridge shared between CM6 event handlers and React context menu. */
export const contextMenuBridge = new ContextMenuBridge()
