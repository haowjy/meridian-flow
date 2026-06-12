// @ts-nocheck
/**
 * ContextPaneController — desktop SURFACE controller for the route-owned
 * Context destination.
 *
 * Purpose: own the route-reconciliation, tab mutations, scroll restoration,
 * and the tree↔tab `openTab`-on-select handler for the Context destination.
 * Key decision: the destination has NO header band AND no separate
 * files-tree surface — the tab strip + file tree + editor live inside ONE
 * `ContextViewer` component (the files tree renders as a left panel below
 * the tab strip). This controller is what `WorkbenchView` drops into the
 * `context-viewer` surface slot.
 */
import type {
  WorkbenchContextTreeFile,
  WorkbenchContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useEffect, useLayoutEffect, useRef } from "react";

import { useWorkbenchContextTree } from "@/client/query/useWorkbenchContextTree";
import { type ContextTab, useContextTabs, useContextTabsActions } from "@/client/stores";

import { ContextViewer } from "./context/ContextViewer";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { findContextFile } from "./context/context-tree";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ContextViewerSurfaceControllerProps = {
  workbenchId: string;
  activeContextScheme: WorkbenchContextTreeScheme | null;
  activeContextPath: string | null;
  onSelectContextPath: (
    path: string,
    scheme?: WorkbenchContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  active: boolean;
  /** Workbench left-sidebar expand toggle, surfaced via the tab strip. */
  sidebarToggle: PaneHeaderRailToggle;
  /** Workbench right-dock expand toggle, surfaced via the tab strip. */
  dockToggle: PaneHeaderRailToggle;
};

export function ContextViewerSurfaceController({
  workbenchId,
  activeContextScheme,
  activeContextPath,
  active,
  sidebarToggle,
  dockToggle,
  onSelectContextPath,
}: ContextViewerSurfaceControllerProps) {
  const { tabs } = useContextTabs(workbenchId);
  const { openTab, closeTab } = useContextTabsActions();
  const activeTab = findActiveTab(tabs, activeContextScheme, activeContextPath);
  const activeTabId = activeTab?.documentId ?? null;
  const lastActiveTabIdRef = useRef<string | null>(null);
  const scrollPositionsRef = useRef(new Map<string, { top: number; left: number }>());
  if (activeTabId) lastActiveTabIdRef.current = activeTabId;
  const retainedActiveTabId =
    activeTabId ??
    (tabs.some((tab) => tab.documentId === lastActiveTabIdRef.current)
      ? lastActiveTabIdRef.current
      : null);

  const needsRouteTab = activeContextScheme !== null && activeContextPath !== null && !activeTab;
  const { tree: routeTree } = useWorkbenchContextTree(workbenchId, activeContextScheme ?? "kb", {
    enabled: needsRouteTab,
  });

  // Guard: openTab fires at most once per (workbenchId, scheme, path)
  // tuple within one need-window. The ref is cleared as soon as the route
  // no longer needs an auto-open, so closing a tab and revisiting the same
  // file later re-opens it instead of being permanently blocked.
  const openTabKey =
    activeContextScheme !== null && activeContextPath !== null
      ? `${workbenchId}:${activeContextScheme}:${activeContextPath}`
      : null;
  const openedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    // Re-arm once the route stops needing an auto-open (the tab now exists,
    // or the route has no context file). Without this, closing a tab and
    // revisiting the same file later would never reopen it.
    if (!needsRouteTab) {
      openedKeyRef.current = null;
      return;
    }
    if (activeContextScheme === null || activeContextPath === null || !routeTree) return;
    if (openedKeyRef.current === openTabKey) return;
    const file = findContextFile(routeTree, activeContextPath);
    if (!file) return;
    openTab(workbenchId, contextTabFromFile(activeContextScheme, file));
    openedKeyRef.current = openTabKey;
  }, [
    activeContextPath,
    activeContextScheme,
    needsRouteTab,
    openTab,
    openTabKey,
    workbenchId,
    routeTree,
  ]);

  function handleSelectTab(documentId: string) {
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    if (!tab) return;
    onSelectContextPath(tab.path, tab.scheme);
  }

  function handleCloseTab(documentId: string) {
    const closedWasActive = documentId === activeTabId;
    const fallback = closeTab(workbenchId, documentId);
    if (!closedWasActive) return;
    if (fallback) {
      onSelectContextPath(fallback.path, fallback.scheme);
      return;
    }
    onSelectContextPath("", activeContextScheme ?? undefined);
  }

  // Tree-row click → open as a tab. Same effect as the old
  // ContextFilesSurfaceController, now lifted alongside the viewer state
  // because the file tree renders inside `ContextViewer`.
  function handleSelectFile(scheme: WorkbenchContextTreeScheme, file: WorkbenchContextTreeFile) {
    const tab = contextTabFromFile(scheme, file);
    openTab(workbenchId, tab);
    onSelectContextPath(tab.path, tab.scheme);
  }

  useLayoutEffect(() => {
    if (!active) return;
    if (!retainedActiveTabId) return;
    const scroller = findEditorScroller(retainedActiveTabId);
    if (!scroller) return;
    const save = () => {
      scroller.dataset.stableLayoutScrollTop = String(scroller.scrollTop);
      scroller.dataset.stableLayoutScrollLeft = String(scroller.scrollLeft);
      scrollPositionsRef.current.set(retainedActiveTabId, {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
      });
    };
    const restore = () => {
      const position = scrollPositionsRef.current.get(retainedActiveTabId) ?? {
        top: Number(scroller.dataset.stableLayoutScrollTop ?? 0),
        left: Number(scroller.dataset.stableLayoutScrollLeft ?? 0),
      };
      if (!position) return;
      scroller.scrollTop = position.top;
      scroller.scrollLeft = position.left;
    };

    const hasSavedPosition = scrollPositionsRef.current.has(retainedActiveTabId);
    let interval: number | null = null;
    let attachTimer: number | null = null;
    let restoreTimer: number | null = null;
    const attachCapture = () => {
      scroller.addEventListener("scroll", save, { passive: true });
      interval = window.setInterval(save, 200);
      save();
    };

    restore();
    requestAnimationFrame(() => requestAnimationFrame(restore));
    if (hasSavedPosition) {
      restoreTimer = window.setInterval(restore, 100);
      attachTimer = window.setTimeout(() => {
        if (restoreTimer) window.clearInterval(restoreTimer);
        restoreTimer = null;
        attachCapture();
      }, 1200);
    } else {
      attachCapture();
    }
    return () => {
      if (attachTimer) window.clearTimeout(attachTimer);
      if (restoreTimer) window.clearInterval(restoreTimer);
      if (interval) window.clearInterval(interval);
      scroller.removeEventListener("scroll", save);
    };
  }, [active, retainedActiveTabId]);

  return (
    <ContextViewer
      workbenchId={workbenchId}
      tabs={tabs}
      activeTabId={retainedActiveTabId}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      sidebarToggle={sidebarToggle}
      dockToggle={dockToggle}
      activeContextScheme={activeContextScheme}
      activeContextPath={activeContextPath}
      onSelectFile={handleSelectFile}
    />
  );
}

function findEditorScroller(documentId: string): HTMLElement | null {
  for (const host of document.querySelectorAll<HTMLElement>("[data-context-editor-document-id]")) {
    if (host.dataset.contextEditorDocumentId !== documentId) continue;
    return host.querySelector<HTMLElement>("[data-stable-layout-scroll]");
  }
  return null;
}

function findActiveTab(
  tabs: ContextTab[],
  scheme: WorkbenchContextTreeScheme | null,
  path: string | null,
): ContextTab | null {
  if (scheme === null || path === null) return null;
  return tabs.find((tab) => tab.scheme === scheme && tab.path === path) ?? null;
}
