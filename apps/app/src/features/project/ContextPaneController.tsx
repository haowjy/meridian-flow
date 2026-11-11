/** ContextPaneController — desktop SURFACE controller for the route-owned Context destination. */

import { documentTitleFromUri } from "@meridian/contracts/context-uri";
import { contextOwner, type ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useCallback, useLayoutEffect } from "react";
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import {
  type ContextTab,
  editorTabsForWork,
  getContextTabs,
  isDraftOnly,
  matchesTabInstance,
  replaceOwner,
  selectedDocumentIdOf,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
} from "@/client/stores";
import {
  useAccountResourceReplica,
  useContextRemovalCoordinator,
} from "./context/account-feature-context";
import { ContextViewer } from "./context/ContextViewer";
import { deriveContextPaneState } from "./context/context-pane-state";
import { selectionAtRoute } from "./context/context-removal-protocol";
import { contextTabRouteKey } from "./context/context-tab-identity";
import type { resolveRouteOwner } from "./context/resolve-route-owner";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import {
  settleWriterClose,
  useFollowOpenDocumentPlacement,
} from "./context/use-follow-open-document-placement";
import { identityCommitMayNavigate, identityCommitRoute } from "./context/use-identity-commit";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "./routing/ProjectNavigationContext";
import type { ProjectRouteMask } from "./routing/ProjectRouteBoundary";
import type { NavigationOptions } from "./routing/project-route";
import { openDocumentInEditor } from "./routing/use-open-document-in-editor";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

export type ContextViewerSurfaceControllerProps = {
  projectId: string;
  resolvedEditor: ReturnType<typeof resolveRouteOwner>;
  /** Null while the requested Work cannot be shown; the frame keeps its navigation. */
  editorWorkId: string | null;
  /** What masks the document body; the tab strip and the address stay outside it. */
  mask: ProjectRouteMask;
  localDocumentId?: string;
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
   * Lands on the recently-opened chooser. No tab closes and the selected tab stays
   * selected in the store; the pane shows no document there.
   */
  onShowEditorRecents: (options: NavigationOptions) => void;
  /** The Editor owns the current screen, including while its route verdict masks the body. */
  routeDisplayed: boolean;
  active: boolean;
  /** Project left-sidebar expand toggle, surfaced via the tab strip. */
  sidebarToggle: PaneHeaderRailToggle;
  /** Project right-dock expand toggle, surfaced via the tab strip. */
  dockToggle: PaneHeaderRailToggle;
};

export function ContextViewerSurfaceController({
  projectId,
  resolvedEditor,
  editorWorkId,
  mask,
  activeContextScheme,
  activeContextPath,
  activeContextChat,
  active,
  onShowEditorRecents,
  sidebarToggle,
  dockToggle,
  onSelectContextPath,
  onOpenContextTarget,
  routeDisplayed,
}: ContextViewerSurfaceControllerProps) {
  const routeWorkId = editorWorkId ?? undefined;
  const captureNavigation = useCaptureProjectNavigation();
  const contextRemoval = useContextRemovalCoordinator();
  const resources = useAccountResourceReplica();

  const { tabs } = useContextTabs(projectId);
  const workspaceHydrated = useContextTabsStore((state) => state._workspaceHydrated);
  const layoutSaveFailed = useContextTabsStore((state) => state._layoutPersistenceError != null);
  const { openTab, updateTrackedTab, selectTab } = useContextTabsActions();
  const visibleTabs = editorWorkId ? editorTabsForWork(tabs, editorWorkId) : [];
  const removalState = useContextRemovalProject(projectId);
  const { workspaceRoute, tab: activeTab } = resolvedEditor;

  const {
    catalog: routeCatalog,
    isError: routeTreeIsError,
    isFetching: routeTreeIsFetching,
  } = useContextCatalogView(projectId, activeContextScheme ?? "kb", {
    enabled:
      routeWorkId !== undefined && activeContextScheme !== null && activeContextPath !== null,
    ...contextOwner(routeWorkId, activeContextChat),
  });

  useLayoutEffect(() => {
    if (!active || activeContextScheme === null || activeContextPath === null) return;
    const selection = removalState.selection;
    if (selection.status === "none") return;
    if (
      routeWorkId === undefined ||
      !selectionAtRoute(selection, {
        scheme: activeContextScheme,
        path: activeContextPath,
        workId: routeWorkId,
        rootThreadId: activeContextChat ?? undefined,
      })
    )
      return;
    const routed = routeCatalog?.findPath(activeContextPath);
    const routedFile = routed?.kind === "file" ? routed : null;
    if (workspaceRoute.kind === "owner" && selection.status === "candidate") {
      // A tab found by its cached path paints but proves nothing: the address answer binds.
      if (workspaceRoute.identity.kind === "server")
        selectTab(projectId, workspaceRoute.tab.documentId, workspaceRoute.tab);
      else
        contextRemoval.bindRouteSelection(
          projectId,
          selection.revision,
          workspaceRoute.identity,
          "answer",
        );
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
      contextRemoval.bindRouteSelection(
        projectId,
        selection.revision,
        {
          kind: "server",
          documentId: routedFile.documentId,
        },
        "answer",
      );
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

  // Names the destination's pending tab; the route installs the real one.
  const openTabKey =
    routeWorkId !== undefined && activeContextScheme !== null && activeContextPath !== null
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
      isDraftOnly(activeTab) ||
      removalState.selection.status !== "bound" ||
      workspaceRoute.kind !== "owner" ||
      isDraftOnly(workspaceRoute.tab) ||
      workspaceRoute.tab.documentId !== removalState.selection.identity.documentId
    )
      return;
    contextRemoval.activate({
      projectId,
      selectionRevision: removalState.selection.revision,
      transitionRevision: removalState.transitionRevision,
      locator: removalState.selection.locator,
      identity: removalState.selection.identity,
      owner: { kind: "workspace", tab: workspaceRoute.tab },
    });
  }, [active, contextRemoval, workspaceRoute, projectId, removalState]);

  // Untitled tabs are store-owned until materialization gives them a server
  // route. Their activation must not depend on search-param validation.
  const paneState = deriveContextPaneState({
    activeTab,
    tabs: visibleTabs,
    mask,
    destination:
      activeContextScheme !== null && activeContextPath && openTabKey
        ? {
            path: activeContextPath,
            scheme: activeContextScheme,
            workId: routeWorkId,
            rootThreadId: activeContextChat ?? undefined,
            optimisticTab: {
              id: `optimistic:${openTabKey}`,
              // Full basename, not the extension-stripped resume label — the chip
              // must match the settled tab's name (`file.name`) it will become.
              name: contextRouteFileName(activeContextPath),
            },
          }
        : null,
    // Closing stamps this fence before removing the tab. Sharing it prevents
    // the loading projection from resurrecting the removed route.
    removalFenced: routeMaterializationFenced,
  });

  function handleSelectTab(tab: ContextTab) {
    if (!getContextTabs(projectId).tabs.some((candidate) => matchesTabInstance(candidate, tab)))
      return;
    const documentId = tab.documentId;
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
    // A pinned review is part of the tab's address: selecting the tab must write it back.
    if (tab.reviewPin) {
      void openDocumentInEditor(onOpenContextTarget, tab, { review: tab.reviewPin });
      return;
    }
    void onOpenContextTarget(
      { scheme: tab.scheme, path: tab.path, workId: routeWorkId, documentId },
      { tab },
    );
  }

  function handleCloseTab(tab: ContextTab) {
    settleWriterClose(contextRemoval.writerClose(projectId, tab));
  }

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

  useFollowOpenDocumentPlacement({
    projectId,
    editorWorkId: routeWorkId,
    selection: removalState.selection,
    activeContextScheme,
    activeContextPath,
    activeContextChat,
    routeDisplayed,
    onOpenContextTarget,
  });

  return (
    <ContextViewer
      layoutSaveFailed={layoutSaveFailed}
      projectId={projectId}
      editorWorkId={editorWorkId}
      mask={mask}
      route={activeContextScheme ? { scheme: activeContextScheme, path: activeContextPath } : null}
      onSelectContextPath={onSelectContextPath}
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
              focus: true,
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
        const target = getContextTabs(projectId).tabs.find((candidate) =>
          matchesTabInstance(candidate, ownership.tab),
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
        } else if (ownership.isLatest && target) {
          // Any commit through the identity bar is an explicit writer save:
          // the document graduates out of provisional naming.
          updateTrackedTab(projectId, target, {
            scheme: next.scheme,
            path: next.path,
            name: next.name,
            ...replaceOwner(next),
            provisionalName: false,
          });
        }
        if (
          activeTab &&
          matchesTabInstance(activeTab, ownership.tab) &&
          next.routeWorkId === routeWorkId &&
          identityCommitMayNavigate(
            ownership,
            selectedDocumentIdOf(getContextTabs(projectId)) ?? undefined,
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

/** The stored name ("Chapter 1") — matches the name a settled tab displays. */
function contextRouteFileName(path: string): string {
  return documentTitleFromUri(path) ?? path.slice(path.lastIndexOf("/") + 1);
}
