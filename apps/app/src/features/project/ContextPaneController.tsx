/**
 * ContextPaneController — desktop SURFACE controller for the route-owned
 * Context destination.
 *
 * Purpose: own route reconciliation, tab mutations, and scroll restoration
 * for the Editor destination. The project sidebar owns the file tree; this
 * controller owns only the persistent tab/document surface.
 */
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  type WorkingSetRoute,
} from "@meridian/contracts/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useDefaultWorkId } from "@/client/query/useWorks";
import { useContextTabs, useContextTabsActions } from "@/client/stores";
import { clearRoutes, promoteRoute, readRecentRoutes, removeRoute } from "@/client/working-set";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

import { ContextViewer } from "./context/ContextViewer";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { contextTabRouteKey, findContextTabForRoute } from "./context/context-tab-identity";
import {
  findContextFile,
  findContextFileByDocumentId,
  firstContextFile,
} from "./context/context-tree";
import {
  type ContextRouteResolution,
  shouldShowOptimisticContextRoute,
} from "./context/optimistic-context-route";
import {
  appendPendingUntitled,
  isUntitledPending,
  untitledDocumentIsEmpty,
} from "./context/untitled-reconciler";
import { useUntitledTabBridge } from "./context/useUntitledTabBridge";
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
  const defaultWorkId = useDefaultWorkId(projectId);
  const routeWorkId = workId ?? defaultWorkId;

  const { tabs, activeTabId } = useContextTabs(projectId);
  const { openTab, closeTab, updateTrackedTab, pruneWorkScopedTabs, selectTab } =
    useContextTabsActions();
  const serverTabs = tabs.filter((tab) => tab.kind !== "new");
  const activeTab = findContextTabForRoute(
    tabs,
    activeContextScheme,
    activeContextPath,
    routeWorkId,
  );
  const [rememberedRoute, setRememberedRoute] = useState<{
    projectId: string;
    route: WorkingSetRoute;
  } | null>(null);
  const lastContextRoute = rememberedRoute?.projectId === projectId ? rememberedRoute.route : null;
  const lastActiveTabIdRef = useRef<string | null>(null);
  const scrollPositionsRef = useRef(new Map<string, { top: number; left: number }>());
  if (activeTabId) lastActiveTabIdRef.current = activeTabId;
  const retainedActiveTabId =
    activeTabId ??
    (tabs.some((tab) => tab.documentId === lastActiveTabIdRef.current)
      ? lastActiveTabIdRef.current
      : null);

  const needsRouteTab = activeContextScheme !== null && activeContextPath !== null && !activeTab;
  const {
    tree: routeTree,
    isError: routeTreeIsError,
    isFetching: routeTreeIsFetching,
  } = useProjectContextTree(projectId, activeContextScheme ?? "kb", {
    enabled: activeContextScheme !== null && activeContextPath !== null,
    activeThreadId,
    workId: routeWorkId,
  });

  // Guard: openTab fires at most once per (projectId, scheme, path)
  // tuple within one need-window. The ref is cleared as soon as the route
  // no longer needs an auto-open, so closing a tab and revisiting the same
  // file later re-opens it instead of being permanently blocked.
  const openTabKey =
    activeContextScheme !== null && activeContextPath !== null
      ? contextTabRouteKey(projectId, activeContextScheme, activeContextPath, routeWorkId)
      : null;
  const openedKeyRef = useRef<string | null>(null);
  const previousRouteStateRef = useRef({ tabs: serverTabs, activeTab });

  useEffect(() => {
    previousRouteStateRef.current = { tabs: serverTabs, activeTab };
  }, [projectId, workId]);

  useEffect(() => {
    pruneWorkScopedTabs(projectId, routeWorkId);
  }, [projectId, pruneWorkScopedTabs, routeWorkId]);

  useEffect(() => {
    if (activeTab) selectTab(projectId, activeTab.documentId);
  }, [activeTab, projectId, selectTab]);

  // Device-local routes are unavailable during SSR. Read after hydration so
  // the server and first client render agree, then keep the resume label current.
  useEffect(() => {
    const route = readRecentRoutes(projectId)[0];
    setRememberedRoute(route ? { projectId, route } : null);
  }, [projectId]);

  // Remember the last-opened file (device-local) once its tab actually
  // resolves — a tree-validated open or a launcher-synthesized draft tab
  // (context-tab-from-draft), never for a dead deep link. Draft-only tabs
  // don't count until accept clears the marker: their path dies if the
  // draft is discarded, and a remembered dead route would replay on the
  // next visit.
  useEffect(() => {
    if (!activeTab || activeTab.draftOnly) return;
    const route = workingSetRoute(activeTab.scheme, activeTab.path, routeWorkId);
    if (!route) return;
    promoteRoute(projectId, route);
    setRememberedRoute({ projectId, route });
  }, [activeTab, projectId, routeWorkId]);

  // Restore, once per SCREEN ENTRY (user call 2026-07-16 — "the last opened
  // thing"): entering Context with no destination replays the remembered
  // file. A deep link (file or scheme browser) is an explicit destination
  // and wins. The ref re-arms when the screen deactivates — the controller
  // is a persistent surface, so a mount-scoped one-shot fired only on the
  // FIRST visit and left every later return on the orphan empty state.
  // Closing the last tab can't resurrect it: the deliberate empty desk
  // already forgets the route, and the ref stays spent while you stay here.
  const restoreAttemptedRef = useRef(false);
  const [wantsDefaultOpen, setWantsDefaultOpen] = useState(false);
  useLayoutEffect(() => {
    if (!active) {
      restoreAttemptedRef.current = false;
      setWantsDefaultOpen(false);
      return;
    }
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    if (activeContextScheme !== null || activeContextPath !== null) return;
    const last = readRecentRoutes(projectId)[0];
    if (last) {
      onSelectContextPath(last.path, last.scheme, { replace: true });
      return;
    }
    // Nothing to restore and an empty desk that was never deliberately
    // emptied (no tabs): land on words instead of the empty state — arm the
    // default open, resolved below once the manuscript tree arrives (user
    // call 2026-07-16: "there should always be documents loaded").
    if (tabs.length === 0) setWantsDefaultOpen(true);
  }, [active]);

  const routeResolution: ContextRouteResolution = routeTree
    ? activeContextPath && findContextFile(routeTree, activeContextPath)
      ? "found"
      : "missing"
    : routeTreeIsFetching && !routeTreeIsError
      ? "loading"
      : "missing";
  const optimisticTab = shouldShowOptimisticContextRoute({
    // An empty path is the deliberate empty-desk route, not a destination.
    hasDestination: activeContextScheme !== null && Boolean(activeContextPath),
    hasActiveTab: activeTab !== null,
    resolution: routeResolution,
    // Closing stamps this key before removing the tab. Sharing the guard
    // prevents the loading projection from resurrecting the closed route.
    autoOpenBlocked: openTabKey !== null && openedKeyRef.current === openTabKey,
  })
    ? {
        id: `optimistic:${openTabKey}`,
        name: contextRouteName(activeContextPath ?? ""),
      }
    : null;

  const { tree: defaultOpenTree } = useProjectContextTree(projectId, "manuscript", {
    enabled: wantsDefaultOpen,
    activeThreadId,
    workId: routeWorkId,
  });
  useEffect(() => {
    if (!wantsDefaultOpen || !defaultOpenTree) return;
    setWantsDefaultOpen(false);
    // The writer (or a late restore) may have opened something while the
    // tree loaded — an explicit destination always wins over the default.
    if (activeContextScheme !== null || activeContextPath !== null || tabs.length > 0) return;
    const file = firstContextFile(defaultOpenTree);
    if (file) onSelectContextPath(file.path, "manuscript", { replace: true });
  }, [wantsDefaultOpen, defaultOpenTree]);

  useEffect(() => {
    const previous = previousRouteStateRef.current;
    previousRouteStateRef.current = { tabs: serverTabs, activeTab };
    const removed = previous.activeTab;
    if (!removed || serverTabs.some((tab) => tab.documentId === removed.documentId)) return;
    if (activeContextScheme !== removed.scheme || activeContextPath !== removed.path) return;

    // A lifecycle disposition can remove a draft-only tab without going
    // through handleCloseTab. Repair the still-active route with the same
    // neighbour policy and resurrection guard as an explicit close.
    openedKeyRef.current = openTabKey;
    const removedIndex = previous.tabs.findIndex((tab) => tab.documentId === removed.documentId);
    const fallback = serverTabs[removedIndex] ?? serverTabs[serverTabs.length - 1] ?? null;
    if (fallback) {
      onSelectContextPath(fallback.path, fallback.scheme);
      return;
    }
    onSelectContextPath("", activeContextScheme ?? undefined);
    clearRoutes(projectId);
    setRememberedRoute(null);
  }, [
    activeContextPath,
    activeContextScheme,
    activeTab,
    onSelectContextPath,
    openTabKey,
    projectId,
    serverTabs,
  ]);

  // A cached tree refetch refreshes metadata on an already-open route too.
  // This is how cross-device renames clear provisional chrome without a new
  // metadata channel.
  useEffect(() => {
    if (!activeTab || !routeTree || activeContextScheme === null) return;
    const file = findContextFileByDocumentId(routeTree, activeTab.documentId);
    if (!file) return;
    openTab(projectId, contextTabFromFile(activeContextScheme, file, routeWorkId));
    if (file.path !== activeTab.path)
      onSelectContextPath(file.path, activeContextScheme, { replace: true });
  }, [
    activeContextScheme,
    activeTab?.documentId,
    onSelectContextPath,
    openTab,
    projectId,
    routeTree,
    routeWorkId,
  ]);

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
    openTab(projectId, contextTabFromFile(activeContextScheme, file, routeWorkId));
    openedKeyRef.current = openTabKey;
  }, [
    activeContextPath,
    activeContextScheme,
    needsRouteTab,
    openTab,
    openTabKey,
    projectId,
    routeTree,
    routeWorkId,
  ]);

  function handleSelectTab(documentId: string) {
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    if (!tab) return;
    selectTab(projectId, documentId);
    if (tab.kind === "new") {
      onSelectContextPath("", activeContextScheme ?? undefined);
      return;
    }
    onSelectContextPath(tab.path, tab.scheme);
  }

  function handleCloseTab(documentId: string) {
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    const closedWasActive = documentId === activeTabId;
    const fallback = closeTab(projectId, documentId);
    if (tab?.kind === "new" && !isUntitledPending(documentId)) {
      const registry = getDocumentSessionRegistry();
      const session = registry.getDetached(documentId);
      if (untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName))) {
        void registry.destroyRoom(documentId, { clearPersistence: true });
      }
    }
    // Closing the last tab is a deliberate "empty desk" — forget the
    // remembered file so it doesn't resurrect on the next visit.
    if (!fallback) {
      clearRoutes(projectId);
      setRememberedRoute(null);
    } else if (tab && tab.kind !== "new") {
      const route = workingSetRoute(tab.scheme, tab.path, tab.workId ?? routeWorkId);
      if (route) removeRoute(projectId, route);
    }
    if (!closedWasActive) return;
    // The route keeps pointing at the closed file until the navigation
    // below lands. Stamp the auto-open guard for that route so the
    // transient (path set, tab missing) window can't re-open — and
    // re-persist — the tab we just closed.
    openedKeyRef.current = openTabKey;
    if (fallback?.kind === "new") {
      onSelectContextPath("", activeContextScheme ?? undefined);
      return;
    }
    if (fallback) {
      onSelectContextPath(fallback.path, fallback.scheme);
      return;
    }
    onSelectContextPath("", activeContextScheme ?? undefined);
  }

  function handleResumeDocument() {
    const last = readRecentRoutes(projectId)[0];
    if (!last) return;
    onSelectContextPath(last.path, last.scheme);
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

  const handleUntitledBecameNonEmpty = useCallback(
    (documentId: string) => {
      appendPendingUntitled({ documentId, projectId });
    },
    [projectId],
  );

  useUntitledTabBridge({ projectId, tabs, defaultWorkId, onSelectContextPath });

  return (
    <ContextViewer
      projectId={projectId}
      activeThreadId={activeThreadId}
      tabs={tabs}
      activeTabId={activeTab?.documentId ?? retainedActiveTabId}
      optimisticTab={optimisticTab}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      sidebarToggle={sidebarToggle}
      dockToggle={dockToggle}
      active={active}
      resumeDocumentName={lastContextRoute ? contextRouteName(lastContextRoute.path) : null}
      onResumeDocument={handleResumeDocument}
      onNewDocument={() => {
        const documentId = crypto.randomUUID();
        getDocumentSessionRegistry().getDetached(documentId);
        openTab(projectId, { kind: "new", documentId, name: "Untitled" });
        selectTab(projectId, documentId);
        onSelectContextPath("", activeContextScheme ?? undefined);
      }}
      onUntitledBecameNonEmpty={handleUntitledBecameNonEmpty}
      onUntitledRenamed={(documentId, name, path) => {
        updateTrackedTab(projectId, documentId, { name, path, provisionalName: false });
        onSelectContextPath(path, "scratch");
      }}
      onOpenExisting={(scheme, path) => onSelectContextPath(path, scheme)}
    />
  );
}

function workingSetRoute(
  scheme: ProjectContextTreeScheme,
  path: string,
  workId: string | null,
): WorkingSetRoute | null {
  if (isWorkScopedProjectContextScheme(scheme)) {
    return workId ? { scheme, path, workId } : null;
  }
  return { scheme, path };
}

function contextRouteName(path: string): string {
  const basename = path.slice(path.lastIndexOf("/") + 1);
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex > 0 ? basename.slice(0, extensionIndex) : basename;
}

function findEditorScroller(documentId: string): HTMLElement | null {
  for (const host of document.querySelectorAll<HTMLElement>("[data-context-editor-document-id]")) {
    if (host.dataset.contextEditorDocumentId !== documentId) continue;
    return host.querySelector<HTMLElement>("[data-stable-layout-scroll]");
  }
  return null;
}
