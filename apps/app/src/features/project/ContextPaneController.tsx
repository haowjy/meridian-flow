/** ContextPaneController — desktop SURFACE controller for the route-owned Context destination. */
import {
  contextOwner,
  type ProjectContextTreeScheme,
  type Work,
} from "@meridian/contracts/protocol";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import {
  getContextTabs,
  isEditorTab,
  replaceOwner,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
} from "@/client/stores";
import {
  useAccountResourceProjection,
  useAccountResourceReplica,
  useContextRemovalCoordinator,
  useProjectContextAvailabilityCoordinator,
} from "./context/account-feature-context";
import { ContextViewer } from "./context/ContextViewer";
import { deriveContextPaneState } from "./context/context-pane-state";
import { contextTabFromFile, projectResourceTab } from "./context/context-tab-from-file";
import { contextTabRouteKey } from "./context/context-tab-identity";
import { resolveVisibleEditorTab } from "./context/resolve-visible-editor-tab";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { identityCommitMayNavigate, identityCommitRoute } from "./context/use-identity-commit";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "./routing/ProjectNavigationContext";
import type { NavigationOptions } from "./routing/project-route";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ContextViewerSurfaceControllerProps = {
  projectId: string;
  editorWorkId: string;
  /** The Editor's Work; its archived state makes its files read-only. */
  editorWork: Work | null;
  localDocumentId?: string;
  addressOwnsDocumentAdmission?: boolean;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  /** A chat's Scratch route names its lineage here, in place of a Work. */
  activeContextChat?: string | null;
  onSelectContextPath: (
    path: string,
    scheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  onOpenContextTarget: OpenContextRoute;
  /**
   * Clears the Editor's selected document without closing tabs, landing on the
   * recently-opened chooser.
   */
  onShowEditorRecents: (options: NavigationOptions) => void;
  active: boolean;
  /** Project left-sidebar expand toggle, surfaced via the tab strip. */
  sidebarToggle: PaneHeaderRailToggle;
  /** Project right-dock expand toggle, surfaced via the tab strip. */
  dockToggle: PaneHeaderRailToggle;
};

export function ContextViewerSurfaceController({
  projectId,
  editorWorkId,
  editorWork,
  localDocumentId,
  addressOwnsDocumentAdmission = false,
  activeContextScheme,
  activeContextPath,
  activeContextChat,
  active,
  onShowEditorRecents,
  sidebarToggle,
  dockToggle,
  onSelectContextPath,
  onOpenContextTarget,
}: ContextViewerSurfaceControllerProps) {
  const routeWorkId = editorWorkId;
  const captureNavigation = useCaptureProjectNavigation();
  const contextRemoval = useContextRemovalCoordinator();
  const availability = useProjectContextAvailabilityCoordinator();
  const resources = useAccountResourceReplica();
  const resourceProjection = useAccountResourceProjection(projectId);

  const { tabs, selectedTabIdByWork } = useContextTabs(projectId);
  const workspaceHydrated = useContextTabsStore((state) => state._workspaceHydrated);
  const layoutSaveFailed = useContextTabsStore((state) => state._layoutPersistenceError != null);
  const { openTab, reconcileResourceTab, updateTrackedTab, selectTab } = useContextTabsActions();
  const visibleTabs = tabs.filter((tab) => isEditorTab(tab, routeWorkId));
  const removalState = useContextRemovalProject(projectId);
  const {
    selectedDocumentId,
    workspaceRoute,
    tab: activeTab,
  } = resolveVisibleEditorTab({
    tabs,
    selectedTabId: selectedTabIdByWork[routeWorkId],
    selection: removalState.selection,
    editorWorkId: routeWorkId,
    localDocumentId,
    activeContextScheme,
    activeContextPath,
    activeContextChat,
  });
  const editorScopeKey = `${projectId}:${routeWorkId}`;
  const scrollPositionsRef = useRef(new Map<string, { top: number; left: number }>());
  const retainedActiveTabId = selectedDocumentId ?? null;

  const needsRouteTab = activeContextScheme !== null && activeContextPath !== null && !activeTab;
  const {
    catalog: routeCatalog,
    isError: routeTreeIsError,
    isFetching: routeTreeIsFetching,
  } = useContextCatalogView(projectId, activeContextScheme ?? "kb", {
    enabled: activeContextScheme !== null && activeContextPath !== null,
    ...contextOwner(routeWorkId, activeContextChat),
  });

  useLayoutEffect(() => {
    if (!active || activeContextScheme === null || activeContextPath === null) return;
    const selection = removalState.selection;
    if (selection.status === "none") return;
    if (
      selection.locator.scheme !== activeContextScheme ||
      selection.locator.path !== activeContextPath ||
      selection.locator.workId !== routeWorkId ||
      selection.locator.rootThreadId !== (activeContextChat ?? undefined)
    )
      return;
    const routed = routeCatalog?.findPath(activeContextPath);
    const routedFile = routed?.kind === "file" ? routed : null;
    if (workspaceRoute.kind === "owner" && selection.status === "candidate") {
      if (workspaceRoute.identity.kind === "server") {
        selectTab(projectId, routeWorkId, workspaceRoute.tab.documentId);
      }
      contextRemoval.bindRouteSelection(projectId, selection.revision, workspaceRoute.identity);
    } else if (workspaceRoute.kind === "materialized-local") {
      contextRemoval.redirectMaterializedLocal(
        projectId,
        selection.revision,
        workspaceRoute.tab.documentId,
        workspaceRoute.target,
      );
    } else if (
      selection.status === "candidate" &&
      routedFile &&
      !routeTreeIsFetching &&
      !routeTreeIsError
    ) {
      contextRemoval.bindRouteSelection(projectId, selection.revision, {
        kind: "server",
        documentId: routedFile.documentId,
      });
    } else if (
      selection.status === "candidate" &&
      activeContextScheme === "unfiled" &&
      activeContextPath === "" &&
      workspaceHydrated
    ) {
      contextRemoval.rejectRouteCandidate(projectId, selection.revision, "missing-local-owner");
    } else if (
      selection.status === "candidate" &&
      routeCatalog &&
      !routeTreeIsFetching &&
      !routeTreeIsError
    ) {
      contextRemoval.rejectRouteCandidate(projectId, selection.revision);
    }
  }, [
    active,
    activeContextChat,
    activeContextPath,
    activeContextScheme,
    contextRemoval,
    workspaceHydrated,
    activeTab,
    workspaceRoute,
    projectId,
    routeCatalog,
    routeTreeIsFetching,
    routeWorkId,
    removalState.selection,
    selectTab,
    tabs,
  ]);

  // Guard: openTab fires at most once per (projectId, scheme, path)
  // tuple within one need-window. The ref is cleared as soon as the route
  // no longer needs an auto-open, so closing a tab and revisiting the same
  // file later re-opens it instead of being permanently blocked.
  const openTabKey =
    activeContextScheme !== null && activeContextPath !== null
      ? contextTabRouteKey(projectId, {
          scheme: activeContextScheme,
          path: activeContextPath,
          workId: routeWorkId,
          rootThreadId: activeContextChat ?? undefined,
        })
      : null;
  const routeMaterializationFenced =
    removalState.removalFence?.selectionRevision === removalState.selection.revision &&
    removalState.removalFence?.locator?.scheme === activeContextScheme &&
    removalState.removalFence.locator.path === activeContextPath &&
    removalState.removalFence.locator.workId === routeWorkId &&
    removalState.removalFence.locator.rootThreadId === (activeContextChat ?? undefined);
  // Remember the last-opened file (device-local) once its tab actually
  // resolves — a tree-validated open or a launcher-synthesized draft tab
  // (context-tab-from-draft), never for a dead deep link. Draft-only tabs
  // don't count until Apply clears the marker: their path dies if the
  // draft is discarded, and a remembered dead route would replay on the
  // next visit.
  useLayoutEffect(() => {
    if (
      !active ||
      !activeTab ||
      activeTab.draftOnly ||
      removalState.selection.status !== "bound" ||
      workspaceRoute.kind !== "owner" ||
      workspaceRoute.tab.draftOnly ||
      workspaceRoute.tab.documentId !== removalState.selection.identity.documentId
    )
      return;
    contextRemoval.activate({
      projectId,
      selectionRevision: removalState.selection.revision,
      transitionRevision: removalState.transitionRevision,
      locator: removalState.selection.locator,
      identity: removalState.selection.identity,
      owner: { kind: "workspace", documentId: workspaceRoute.tab.documentId },
    });
  }, [active, contextRemoval, workspaceRoute, projectId, removalState]);

  useLayoutEffect(() => {
    scrollPositionsRef.current.clear();
  }, [editorScopeKey]);

  // Untitled tabs are store-owned until materialization gives them a server
  // route. Their activation must not depend on search-param validation.
  const paneState = deriveContextPaneState({
    activeTab,
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
    catalog: routeCatalog,
    isFetching: routeTreeIsFetching,
    isError: routeTreeIsError,
    // Closing stamps this fence before removing the tab. Sharing it prevents
    // the loading projection from resurrecting the removed route.
    removalFenced: routeMaterializationFenced,
  });

  useEffect(() => {
    if (!active || addressOwnsDocumentAdmission || !needsRouteTab || routeMaterializationFenced)
      return;
    if (activeContextScheme === null || activeContextPath === null || !routeCatalog) return;
    const found = routeCatalog.findPath(activeContextPath);
    const file = found?.kind === "file" ? found : null;
    if (!file) return;
    openTab(
      projectId,
      contextTabFromFile(activeContextScheme, file, contextOwner(routeWorkId, activeContextChat)),
    );
  }, [
    active,
    addressOwnsDocumentAdmission,
    activeContextChat,
    activeContextPath,
    activeContextScheme,
    needsRouteTab,
    openTab,
    openTabKey,
    projectId,
    routeCatalog,
    routeMaterializationFenced,
    routeWorkId,
  ]);

  function handleSelectTab(documentId: string) {
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    if (!tab) return;
    if (tab.kind === "new") {
      onOpenContextTarget({ scheme: "unfiled", path: "", workId: routeWorkId, documentId });
      return;
    }
    if (tab.rootThreadId) {
      void onOpenContextTarget({
        scheme: tab.scheme,
        path: tab.path,
        workId: routeWorkId,
        rootThreadId: tab.rootThreadId,
        documentId,
      });
      return;
    }
    onSelectContextPath(tab.path, tab.scheme);
  }

  function handleCloseTab(documentId: string) {
    settleWriterClose(contextRemoval.writerClose(projectId, documentId));
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
    async (documentId: string) => {
      const tab = getContextTabs(projectId).tabs.find(
        (candidate) => candidate.documentId === documentId,
      );
      if (tab?.kind !== "new") return;
      await resources.markCreateEligible({ handle: tab.resourceHandle });
    },
    [projectId, resources],
  );

  useEffect(() => {
    for (const tab of tabs) {
      const projection = projectResourceTab(
        projectId,
        tab,
        resourceProjection.records,
        resourceProjection.folders,
      );
      if (projection.kind === "none") continue;
      if (projection.kind === "terminal") {
        void availability
          .acceptCommittedDelete({
            projectId,
            deletedDocumentIds: projection.documentIds,
            generation: projection.generation,
          })
          .catch((error: unknown) => reportError(error));
        continue;
      }
      if (projection.kind === "removed") {
        settleWriterClose(contextRemoval.writerClose(projectId, tab.documentId));
        continue;
      }
      const routeFollowsTab =
        active &&
        tab.kind !== "new" &&
        projection.tab.kind !== "new" &&
        selectedDocumentId === tab.documentId &&
        activeContextScheme === tab.scheme &&
        activeContextPath === tab.path &&
        (projection.tab.scheme !== tab.scheme ||
          projection.tab.path !== tab.path ||
          projection.tab.workId !== tab.workId ||
          projection.tab.rootThreadId !== tab.rootThreadId);
      void reconcileResourceTab(projectId, projection.resourceHandle, projection.tab).catch(
        (error: unknown) => reportError(error),
      );
      if (routeFollowsTab && projection.tab.kind !== "new")
        void onOpenContextTarget(
          {
            scheme: projection.tab.scheme,
            path: projection.tab.path,
            workId: projection.tab.workId ?? routeWorkId,
            ...(projection.tab.rootThreadId ? { rootThreadId: projection.tab.rootThreadId } : {}),
            documentId: projection.tab.documentId,
          },
          { replace: true, tab: projection.tab },
        ).then(
          (settlement) => {
            if (settlement.kind === "failed") reportError(settlement.error);
          },
          (error: unknown) => reportError(error),
        );
    }
  }, [
    active,
    activeContextPath,
    activeContextScheme,
    availability,
    contextRemoval,
    onOpenContextTarget,
    projectId,
    reconcileResourceTab,
    resourceProjection.records,
    resourceProjection.folders,
    routeWorkId,
    selectedDocumentId,
    tabs,
  ]);

  return (
    <ContextViewer
      layoutSaveFailed={layoutSaveFailed}
      projectId={projectId}
      editorWorkId={routeWorkId}
      editorWork={editorWork}
      tabs={visibleTabs}
      paneState={paneState}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      onShowRecents={() => onShowEditorRecents({ replace: false })}
      sidebarToggle={sidebarToggle}
      dockToggle={dockToggle}
      active={active}
      onNewDocument={async () => {
        const isCurrent = captureNavigation?.();
        const reservation = await resources.reserveDocument(projectId);
        if (reservation.content.kind !== "opened") throw new Error("Local document is unavailable");
        try {
          if (isCurrent?.() === false) return;
          const documentId = reservation.content.handle.documentId;
          const result = await onOpenContextTarget(
            { scheme: "unfiled", path: "", workId: routeWorkId, documentId },
            {
              isCurrent,
              tab: {
                kind: "new",
                documentId,
                name: reservation.name,
                resourceHandle: reservation.key.handle,
              },
            },
          );
          if (result.kind === "failed") throw result.error;
        } finally {
          reservation.content.handle.release();
        }
      }}
      onUntitledBecameNonEmpty={handleUntitledBecameNonEmpty}
      onCommitted={(documentId, next, ownership) => {
        const target = getContextTabs(projectId).tabs.find(
          (candidate) => candidate.documentId === documentId,
        );
        if (ownership.isLatest && target?.kind === "viewer") {
          // openTab merges metadata for an already-open tab; the store has no
          // viewer-specific patch action.
          openTab(projectId, {
            ...target,
            scheme: next.scheme,
            path: next.path,
            name: next.name,
            ...replaceOwner(next),
          } as typeof target);
        } else if (ownership.isLatest) {
          // Any commit through the identity bar is an explicit writer save:
          // the document graduates out of provisional naming (D8).
          updateTrackedTab(projectId, documentId, {
            scheme: next.scheme,
            path: next.path,
            name: next.name,
            ...replaceOwner(next),
            provisionalName: false,
          });
        }
        if (
          identityCommitMayNavigate(
            ownership,
            getContextTabs(projectId).selectedTabIdByWork[routeWorkId],
            documentId,
          )
        ) {
          const { request, options } = identityCommitRoute(documentId, next);
          void onOpenContextTarget(request, options).then(
            (settlement) => {
              if (settlement.kind === "failed") reportError(settlement.error);
            },
            (error: unknown) => reportError(error),
          );
        }
      }}
      onOpenExisting={(scheme, path, owner) => {
        // A chat's Scratch note is addressed by its lineage; anything else inherits the Editor's Work.
        if (owner.rootThreadId)
          void onOpenContextTarget({
            scheme,
            path,
            workId: routeWorkId,
            rootThreadId: owner.rootThreadId,
          });
        else onSelectContextPath(path, scheme);
      }}
    />
  );
}

function settleWriterClose(
  result: ReturnType<ReturnType<typeof useContextRemovalCoordinator>["writerClose"]>,
): void {
  if (!(result instanceof Promise)) return;
  void result.then(
    (settlement) => {
      if (settlement.kind === "failed") reportError(settlement.error);
    },
    (error: unknown) => reportError(error),
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
