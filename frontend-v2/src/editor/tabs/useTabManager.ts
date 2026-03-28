import type { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"

import { TabManager, type TabInfo } from "./tab-manager"

export interface UseTabManagerOptions {
  /** Maximum number of live EditorViews. Default: 6 */
  maxLive?: number
  /** Called when a new EditorView needs to be created for a document */
  createEditorView: (
    documentId: string,
    container: HTMLDivElement,
    cachedState?: EditorState | null,
  ) => EditorView
}

export interface UseTabManagerResult {
  /** Ref to set on the host container element */
  hostRef: React.RefCallback<HTMLDivElement>
  /** All open tabs */
  tabs: TabInfo[]
  /** Currently active tab ID */
  activeTabId: string | null
  /** Open or switch to a tab */
  openTab: (documentId: string, documentName: string) => EditorView | null
  /** Switch to an existing tab */
  switchTo: (documentId: string) => EditorView | null
  /** Close a tab */
  closeTab: (documentId: string) => void
  /** Mark a tab as modified */
  setModified: (documentId: string, modified: boolean) => void
  /** Rename a tab */
  renameTab: (documentId: string, newName: string) => void
  /** Get the active EditorView */
  getActiveEditorView: () => EditorView | null
  /** Get an EditorView by document ID */
  getEditorView: (documentId: string) => EditorView | null
}

/**
 * React hook wrapping TabManager for state integration.
 *
 * Uses useSyncExternalStore with TabManager's built-in subscription
 * for tear-free reads. No ref access during render.
 */
export function useTabManager(
  options: UseTabManagerOptions,
): UseTabManagerResult {
  // Stable TabManager instance. useMemo with [] deps runs once.
  // The createEditorView callback is captured by the manager at init;
  // we update it via the effect below to avoid stale closures.
  const manager = useMemo(
    () =>
      new TabManager({
        maxLive: options.maxLive,
        createEditorView: options.createEditorView,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally stable
    [],
  )

  // Keep createEditorView in sync without ref access during render.
  // TabManager.updateCreateEditorView is called in an effect.
  useEffect(() => {
    manager.updateCreateEditorView(options.createEditorView)
  }, [manager, options.createEditorView])

  const { tabs, activeTabId } = useSyncExternalStore(
    manager.subscribe,
    manager.getSnapshot,
    manager.getSnapshot,
  )

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      manager.destroy()
    }
  }, [manager])

  const hostRef = useCallback(
    (el: HTMLDivElement | null) => {
      manager.setHost(el)
    },
    [manager],
  )

  const openTab = useCallback(
    (documentId: string, documentName: string) =>
      manager.openTab(documentId, documentName),
    [manager],
  )

  const switchTo = useCallback(
    (documentId: string) => manager.switchTo(documentId),
    [manager],
  )

  const closeTab = useCallback(
    (documentId: string) => manager.closeTab(documentId),
    [manager],
  )

  const setModified = useCallback(
    (documentId: string, modified: boolean) =>
      manager.setModified(documentId, modified),
    [manager],
  )

  const renameTab = useCallback(
    (documentId: string, newName: string) =>
      manager.renameTab(documentId, newName),
    [manager],
  )

  const getActiveEditorView = useCallback(
    () => manager.getActiveEditorView(),
    [manager],
  )

  const getEditorView = useCallback(
    (documentId: string) => manager.getEditorView(documentId),
    [manager],
  )

  return {
    hostRef,
    tabs,
    activeTabId,
    openTab,
    switchTo,
    closeTab,
    setModified,
    renameTab,
    getActiveEditorView,
    getEditorView,
  }
}
