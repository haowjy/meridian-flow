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
} from "@meridian/contracts/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import { useContextTabs, useContextTabsActions, useContextTabsStore } from "@/client/stores";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

import { ContextViewer } from "./context/ContextViewer";
import { deriveContextPaneState, findActiveUntitledTab } from "./context/context-pane-state";
import { contextRemovalCoordinator } from "./context/context-removal-coordinator";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { contextTabRouteKey, findContextTabForRoute } from "./context/context-tab-identity";
import {
  findContextFile,
  findContextFileByDocumentId,
  firstContextFile,
} from "./context/context-tree";
import { untitledDocumentIsEmpty } from "./context/untitled-reconciler";
import { appendPendingUntitled, isUntitledPending } from "./context/untitled-reconciler-browser";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { identityCommitMayNavigate } from "./context/use-identity-commit";
import { useUntitledTabBridge } from "./context/useUntitledTabBridge";
import type { ContextRouteTarget } from "./routing/project-route";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ContextViewerSurfaceControllerProps = {
  projectId: string;
  editorWorkId: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  onSelectContextPath: (
    path: string,
    scheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  onOpenContextTarget: (target: ContextRouteTarget, options?: { replace?: boolean }) => void;
  active: boolean;
  /** Project left-sidebar expand toggle, surfaced via the tab strip. */
  sidebarToggle: PaneHeaderRailToggle;
  /** Project right-dock expand toggle, surfaced via the tab strip. */
  dockToggle: PaneHeaderRailToggle;
};

export function ContextViewerSurfaceController({
  projectId,
  editorWorkId,
  activeContextScheme,
  activeContextPath,
  active,
  sidebarToggle,
  dockToggle,
  onSelectContextPath,
  onOpenContextTarget,
}: ContextViewerSurfaceControllerProps) {
  const routeWorkId = editorWorkId;

  const { tabs, activeTabId } = useContextTabs(projectId);
  const { openTab, updateTrackedTab, selectTab } = useContextTabsActions();
  const hasEditorWorkTab = tabs.some(
    (tab) =>
      tab.kind === "new" ||
      !isWorkScopedProjectContextScheme(tab.scheme) ||
      tab.workId === routeWorkId,
  );
  const activeTab = findContextTabForRoute(
    tabs,
    activeContextScheme,
    activeContextPath,
    routeWorkId,
  );
  const removalState = useContextRemovalProject(projectId);
  const editorScopeKey = `${projectId}:${routeWorkId ?? "no-work"}`;
  const lastContextRoute = removalState.rememberedRoute;
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
    workId: routeWorkId,
  });

  useLayoutEffect(() => {
    if (!active || activeContextScheme === null || activeContextPath === null) return;
    const selection = removalState.selection;
    if (selection.status !== "pending") return;
    if (
      selection.locator.scheme !== activeContextScheme ||
      selection.locator.path !== activeContextPath ||
      selection.locator.workId !== routeWorkId
    )
      return;
    const routedTab =
      activeTab ??
      (activeContextScheme === "scratch" && activeContextPath === ""
        ? tabs.find((tab) => tab.kind === "new" && tab.documentId === activeTabId)
        : null);
    const routedFile = routeTree ? findContextFile(routeTree, activeContextPath) : null;
    if (routedTab) {
      contextRemovalCoordinator.bindRouteSelection(projectId, selection.revision, {
        kind: routedTab.kind === "new" ? "local" : "server",
        documentId: routedTab.documentId,
      });
    } else if (routedFile) {
      contextRemovalCoordinator.bindRouteSelection(projectId, selection.revision, {
        kind: "server",
        documentId: routedFile.documentId,
      });
    } else if (routeTree && !routeTreeIsFetching) {
      contextRemovalCoordinator.confirmRouteUnbound(projectId, selection.revision);
    }
  }, [
    active,
    activeContextPath,
    activeContextScheme,
    activeTab,
    activeTabId,
    projectId,
    routeTree,
    routeTreeIsFetching,
    routeWorkId,
    removalState.selection,
    tabs,
  ]);

  // Guard: openTab fires at most once per (projectId, scheme, path)
  // tuple within one need-window. The ref is cleared as soon as the route
  // no longer needs an auto-open, so closing a tab and revisiting the same
  // file later re-opens it instead of being permanently blocked.
  const openTabKey =
    activeContextScheme !== null && activeContextPath !== null
      ? contextTabRouteKey(projectId, activeContextScheme, activeContextPath, routeWorkId)
      : null;
  useEffect(() => {
    if (activeTab) selectTab(projectId, activeTab.documentId);
  }, [activeTab, projectId, selectTab]);

  // Remember the last-opened file (device-local) once its tab actually
  // resolves — a tree-validated open or a launcher-synthesized draft tab
  // (context-tab-from-draft), never for a dead deep link. Draft-only tabs
  // don't count until Apply clears the marker: their path dies if the
  // draft is discarded, and a remembered dead route would replay on the
  // next visit.
  useEffect(() => {
    if (!activeTab || activeTab.draftOnly) return;
    contextRemovalCoordinator.activateRoute(projectId, activeTab, routeWorkId);
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
  const restoreScopeRef = useRef(editorScopeKey);
  useLayoutEffect(() => {
    if (restoreScopeRef.current !== editorScopeKey) {
      restoreScopeRef.current = editorScopeKey;
      restoreAttemptedRef.current = false;
      lastActiveTabIdRef.current = null;
      scrollPositionsRef.current.clear();
      setWantsDefaultOpen(false);
    }
    if (!active) {
      restoreAttemptedRef.current = false;
      setWantsDefaultOpen(false);
      return;
    }
    if (restoreAttemptedRef.current) return;
    restoreAttemptedRef.current = true;
    if (activeContextScheme !== null || activeContextPath !== null) return;
    const last = removalState.rememberedRoute;
    if (last) {
      void onOpenContextTarget(last, { replace: true });
      return;
    }
    // Nothing to restore and an empty desk that was never deliberately
    // emptied (no tabs): land on words instead of the empty state — arm the
    // default open, resolved below once the manuscript tree arrives (user
    // call 2026-07-16: "there should always be documents loaded").
    if (!hasEditorWorkTab) setWantsDefaultOpen(true);
  }, [
    active,
    activeContextPath,
    activeContextScheme,
    activeTab,
    editorScopeKey,
    onSelectContextPath,
    projectId,
    routeWorkId,
    hasEditorWorkTab,
    removalState.rememberedRoute,
    onOpenContextTarget,
  ]);

  // Untitled tabs are store-owned until materialization gives them a server
  // route. Their activation must not depend on search-param validation.
  const selectedUntitledTab = findActiveUntitledTab(tabs, retainedActiveTabId);
  const paneState = deriveContextPaneState({
    activeTab: activeTab ?? selectedUntitledTab,
    destination:
      activeContextScheme !== null && activeContextPath && openTabKey
        ? {
            path: activeContextPath,
            scheme: activeContextScheme,
            optimisticTab: {
              id: `optimistic:${openTabKey}`,
              // Full basename, not the extension-stripped resume label — the chip
              // must match the settled tab's name (`file.name`) it will become.
              name: contextRouteFileName(activeContextPath),
            },
          }
        : null,
    tree: routeTree,
    isFetching: routeTreeIsFetching,
    isError: routeTreeIsError,
    // Closing stamps this key before removing the tab. Sharing the guard
    // prevents the loading projection from resurrecting the closed route.
    autoOpenBlocked:
      removalState.autoOpenBlock?.selectionRevision === removalState.selection.revision &&
      removalState.autoOpenBlock?.locator?.scheme === activeContextScheme &&
      removalState.autoOpenBlock.locator.path === activeContextPath &&
      removalState.autoOpenBlock.locator.workId === routeWorkId,
  });

  const { tree: defaultOpenTree } = useProjectContextTree(projectId, "manuscript", {
    enabled: wantsDefaultOpen,
    workId: routeWorkId,
  });
  useEffect(() => {
    if (!wantsDefaultOpen || !defaultOpenTree) return;
    setWantsDefaultOpen(false);
    // The writer (or a late restore) may have opened something while the
    // tree loaded — an explicit destination always wins over the default.
    if (activeContextScheme !== null || activeContextPath !== null || hasEditorWorkTab) return;
    const file = firstContextFile(defaultOpenTree);
    if (file) onSelectContextPath(file.path, "manuscript", { replace: true });
  }, [
    activeContextPath,
    activeContextScheme,
    defaultOpenTree,
    hasEditorWorkTab,
    onSelectContextPath,
    wantsDefaultOpen,
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
    if (!needsRouteTab) return;
    if (activeContextScheme === null || activeContextPath === null || !routeTree) return;
    const file = findContextFile(routeTree, activeContextPath);
    if (!file) return;
    openTab(projectId, contextTabFromFile(activeContextScheme, file, routeWorkId));
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
      onSelectContextPath("", "scratch");
      return;
    }
    onSelectContextPath(tab.path, tab.scheme);
  }

  function handleCloseTab(documentId: string) {
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    void contextRemovalCoordinator.writerClose(projectId, documentId);
    if (tab?.kind === "new" && !isUntitledPending(documentId)) {
      const registry = getDocumentSessionRegistry();
      const session = registry.getDetached(documentId);
      if (untitledDocumentIsEmpty(session.document.getXmlFragment(session.fragmentName))) {
        void registry.destroyRoom(documentId, { clearPersistence: true });
      }
    }
  }

  function handleResumeDocument() {
    const last = removalState.rememberedRoute;
    if (!last) return;
    void onOpenContextTarget(last);
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
      appendPendingUntitled({
        documentId,
        projectId,
        ...(routeWorkId ? { home: { scheme: "scratch" as const, workId: routeWorkId } } : {}),
      });
    },
    [projectId, routeWorkId],
  );

  useUntitledTabBridge({ projectId, tabs, onOpenContextTarget });

  return (
    <ContextViewer
      projectId={projectId}
      editorWorkId={routeWorkId}
      tabs={tabs}
      paneState={paneState}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      sidebarToggle={sidebarToggle}
      dockToggle={dockToggle}
      active={active}
      resumeDocumentName={lastContextRoute ? contextRouteFileName(lastContextRoute.path) : null}
      onResumeDocument={handleResumeDocument}
      onNewDocument={() => {
        const documentId = crypto.randomUUID();
        getDocumentSessionRegistry().getDetached(documentId);
        openTab(projectId, { kind: "new", documentId, name: "Untitled" });
        selectTab(projectId, documentId);
        onSelectContextPath("", "scratch");
      }}
      onUntitledBecameNonEmpty={handleUntitledBecameNonEmpty}
      onCommitted={(documentId, next, ownership) => {
        const liveSlice = useContextTabsStore.getState().byProject[projectId];
        const target = liveSlice?.tabs.find((candidate) => candidate.documentId === documentId);
        if (ownership.isLatest && target?.kind === "viewer") {
          // openTab merges metadata for an already-open tab; the store has no
          // viewer-specific patch action.
          openTab(projectId, {
            ...target,
            scheme: next.scheme,
            path: next.path,
            name: next.name,
            workId: next.workId,
          });
        } else if (ownership.isLatest) {
          // Any commit through the identity bar is an explicit writer save:
          // the document graduates out of provisional naming (D8).
          updateTrackedTab(projectId, documentId, {
            scheme: next.scheme,
            path: next.path,
            name: next.name,
            workId: next.workId,
            provisionalName: false,
          });
        }
        if (identityCommitMayNavigate(ownership, liveSlice?.activeTabId, documentId)) {
          onOpenContextTarget({
            path: next.path,
            scheme: next.scheme,
            workId: next.routeWorkId,
          });
        }
      }}
      onOpenExisting={(scheme, path) => onSelectContextPath(path, scheme)}
    />
  );
}

/** Full basename ("chapter-1.md") — matches the name a settled tab displays. */
function contextRouteFileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function findEditorScroller(documentId: string): HTMLElement | null {
  for (const host of document.querySelectorAll<HTMLElement>("[data-context-editor-document-id]")) {
    if (host.dataset.contextEditorDocumentId !== documentId) continue;
    return host.querySelector<HTMLElement>("[data-stable-layout-scroll]");
  }
  return null;
}
