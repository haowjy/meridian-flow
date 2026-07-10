/**
 * ContextPaneController — desktop SURFACE controller for the route-owned
 * Context destination.
 *
 * Purpose: own the route-reconciliation, tab mutations, scroll restoration,
 * and the tree↔tab `openTab`-on-select handler for the Context destination.
 * Key decision: the destination has NO header band AND no separate
 * files-tree surface — the tab strip + file tree + editor live inside ONE
 * `ContextViewer` component (the files tree renders as a left panel below
 * the tab strip). This controller is what `ProjectView` drops into the
 * `context-viewer` surface slot.
 */
import type {
  ProjectContextTreeFile,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useContextTabs, useContextTabsActions } from "@/client/stores";

import { ContextViewer } from "./context/ContextViewer";
import { readLastContextRoute, saveLastContextRoute } from "./context/context-last-route";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { contextTabRouteKey, findContextTabForRoute } from "./context/context-tab-identity";
import { findContextFile } from "./context/context-tree";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ContextViewerSurfaceControllerProps = {
  projectId: string;
  activeThreadId: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  onSelectContextPath: (
    path: string,
    scheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  active: boolean;
  /** Project left-sidebar expand toggle, surfaced via the tab strip. */
  sidebarToggle: PaneHeaderRailToggle;
  /** Project right-dock expand toggle, surfaced via the tab strip. */
  dockToggle: PaneHeaderRailToggle;
};

export function ContextViewerSurfaceController({
  projectId,
  activeThreadId,
  activeContextScheme,
  activeContextPath,
  active,
  sidebarToggle,
  dockToggle,
  onSelectContextPath,
}: ContextViewerSurfaceControllerProps) {
  const workId = useContextWorkId(projectId, activeThreadId);
  const { tabs } = useContextTabs(projectId);
  const { openTab, closeTab, pruneWorkScopedTabs } = useContextTabsActions();
  const activeTab = findContextTabForRoute(tabs, activeContextScheme, activeContextPath, workId);
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
  const { tree: routeTree } = useProjectContextTree(projectId, activeContextScheme ?? "kb", {
    enabled: needsRouteTab,
    activeThreadId,
  });

  // Guard: openTab fires at most once per (projectId, scheme, path)
  // tuple within one need-window. The ref is cleared as soon as the route
  // no longer needs an auto-open, so closing a tab and revisiting the same
  // file later re-opens it instead of being permanently blocked.
  const openTabKey =
    activeContextScheme !== null && activeContextPath !== null
      ? contextTabRouteKey(projectId, activeContextScheme, activeContextPath, workId)
      : null;
  const openedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    pruneWorkScopedTabs(projectId, workId);
  }, [projectId, pruneWorkScopedTabs, workId]);

  // Remember the last-opened file (device-local) once its tab actually
  // resolves — a tree-validated open or a launcher-synthesized draft tab
  // (context-tab-from-draft), never for a dead deep link. Draft-only tabs
  // don't count until accept clears the marker: their path dies if the
  // draft is discarded, and a remembered dead route would replay on the
  // next visit.
  useEffect(() => {
    if (!activeTab || activeTab.draftOnly) return;
    saveLastContextRoute(projectId, { scheme: activeTab.scheme, path: activeTab.path });
  }, [activeTab, projectId]);

  // One-shot restore: landing on Context with no destination replays the
  // remembered file. A deep link (file or scheme browser) is an explicit
  // destination and wins; closing the last tab later must not re-trigger
  // this, hence the ref.
  const restoreAttemptedRef = useRef(false);
  useEffect(() => {
    if (restoreAttemptedRef.current || !active) return;
    restoreAttemptedRef.current = true;
    if (activeContextScheme !== null || activeContextPath !== null) return;
    const last = readLastContextRoute(projectId);
    if (!last) return;
    onSelectContextPath(last.path, last.scheme, { replace: true });
  }, [active]);

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
    openTab(projectId, contextTabFromFile(activeContextScheme, file, workId));
    openedKeyRef.current = openTabKey;
  }, [
    activeContextPath,
    activeContextScheme,
    needsRouteTab,
    openTab,
    openTabKey,
    projectId,
    routeTree,
    workId,
  ]);

  function handleSelectTab(documentId: string) {
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    if (!tab) return;
    onSelectContextPath(tab.path, tab.scheme);
  }

  function handleCloseTab(documentId: string) {
    const closedWasActive = documentId === activeTabId;
    const fallback = closeTab(projectId, documentId);
    // Closing the last tab is a deliberate "empty desk" — forget the
    // remembered file so it doesn't resurrect on the next visit.
    if (!fallback) saveLastContextRoute(projectId, null);
    if (!closedWasActive) return;
    // The route keeps pointing at the closed file until the navigation
    // below lands. Stamp the auto-open guard for that route so the
    // transient (path set, tab missing) window can't re-open — and
    // re-persist — the tab we just closed.
    openedKeyRef.current = openTabKey;
    if (fallback) {
      onSelectContextPath(fallback.path, fallback.scheme);
      return;
    }
    onSelectContextPath("", activeContextScheme ?? undefined);
  }

  // Tree-row click → open as a tab. Same effect as the old
  // ContextFilesSurfaceController, now lifted alongside the viewer state
  // because the file tree renders inside `ContextViewer`.
  function handleSelectFile(scheme: ProjectContextTreeScheme, file: ProjectContextTreeFile) {
    const tab = contextTabFromFile(scheme, file, workId);
    openTab(projectId, tab);
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
      projectId={projectId}
      activeThreadId={activeThreadId}
      tabs={tabs}
      activeTabId={retainedActiveTabId}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      sidebarToggle={sidebarToggle}
      dockToggle={dockToggle}
      activeContextScheme={activeContextScheme}
      activeContextPath={activeContextPath}
      active={active}
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
