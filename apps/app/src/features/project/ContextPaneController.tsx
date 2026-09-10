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
import { useContextCatalogView } from "@/client/query/useContextCatalog";
import {
  getContextTabs,
  useContextTabs,
  useContextTabsActions,
  useContextTabsStore,
} from "@/client/stores";
import {
  useContextRemovalCoordinator,
  useLocalUntitledOwner,
} from "./context/account-feature-context";
import { ContextViewer } from "./context/ContextViewer";
import { deriveContextPaneState } from "./context/context-pane-state";
import { routeTargetForTab } from "./context/context-removal-planner";
import { resolveDeskRoute } from "./context/context-route-desk-owner";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { contextTabRouteKey } from "./context/context-tab-identity";
import { appendPendingUntitled, isUntitledPending } from "./context/untitled-reconciler-browser";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { identityCommitMayNavigate } from "./context/use-identity-commit";
import { useUntitledTabBridge } from "./context/useUntitledTabBridge";
import { useOptionalPostApplyDisposition } from "./draft-apply-recovery/DraftApplyRecoveryProvider";
import { useOptionalProjectDraftApplyRecovery } from "./draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
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
  const contextRemoval = useContextRemovalCoordinator();
  const localUntitled = useLocalUntitledOwner();
  const postApply = useOptionalPostApplyDisposition();
  const postApplyCommands = useOptionalProjectDraftApplyRecovery();

  const { tabs, selectedTabIdByWork } = useContextTabs(projectId);
  const selectedDocumentId = routeWorkId ? selectedTabIdByWork[routeWorkId] : undefined;
  const deskHydrated = useContextTabsStore((state) => state._deskHydrated);
  const { openTab, updateTrackedTab, selectTab } = useContextTabsActions();
  const visibleTabs = tabs.filter((tab) => {
    if (tab.kind === "new") return (tab.workId ?? null) === routeWorkId;
    return !isWorkScopedProjectContextScheme(tab.scheme) || (tab.workId ?? null) === routeWorkId;
  });
  const hasEditorWorkTab = visibleTabs.length > 0;
  const locator =
    activeContextScheme !== null && activeContextPath !== null
      ? { scheme: activeContextScheme, path: activeContextPath, workId: routeWorkId }
      : null;
  const deskRoute = resolveDeskRoute({ tabs, selectedDocumentId, locator });
  const activeTab = deskRoute.kind === "unowned" ? null : deskRoute.tab;
  const removalState = useContextRemovalProject(projectId);
  const editorScopeKey = `${projectId}:${routeWorkId ?? "no-work"}`;
  const lastContextRoute = removalState.admitted;
  const scrollPositionsRef = useRef(new Map<string, { top: number; left: number }>());
  const retainedActiveTabId = selectedDocumentId ?? null;

  const needsRouteTab = activeContextScheme !== null && activeContextPath !== null && !activeTab;
  const {
    catalog: routeCatalog,
    isError: routeTreeIsError,
    isFetching: routeTreeIsFetching,
  } = useContextCatalogView(projectId, activeContextScheme ?? "kb", {
    enabled: activeContextScheme !== null && activeContextPath !== null,
    workId: routeWorkId,
  });

  useLayoutEffect(() => {
    if (!active || activeContextScheme === null || activeContextPath === null) return;
    const selection = removalState.selection;
    if (selection.status === "none") return;
    if (
      selection.locator.scheme !== activeContextScheme ||
      selection.locator.path !== activeContextPath ||
      selection.locator.workId !== routeWorkId
    )
      return;
    const routed = routeCatalog?.findPath(activeContextPath);
    const routedFile = routed?.kind === "file" ? routed : null;
    if (deskRoute.kind === "owner" && selection.status === "candidate") {
      if (deskRoute.identity.kind === "server" && routeWorkId) {
        selectTab(projectId, routeWorkId, deskRoute.tab.documentId);
      }
      contextRemoval.bindRouteSelection(projectId, selection.revision, deskRoute.identity);
    } else if (deskRoute.kind === "materialized-local") {
      contextRemoval.redirectMaterializedLocal(
        projectId,
        selection.revision,
        deskRoute.tab.documentId,
        deskRoute.target,
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
      activeContextScheme === "scratch" &&
      activeContextPath === "" &&
      deskHydrated
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
    activeContextPath,
    activeContextScheme,
    contextRemoval,
    deskHydrated,
    activeTab,
    deskRoute,
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
      ? contextTabRouteKey(projectId, activeContextScheme, activeContextPath, routeWorkId)
      : null;
  const routeMaterializationFenced =
    removalState.removalFence?.selectionRevision === removalState.selection.revision &&
    removalState.removalFence?.locator?.scheme === activeContextScheme &&
    removalState.removalFence.locator.path === activeContextPath &&
    removalState.removalFence.locator.workId === routeWorkId;
  // Remember the last-opened file (device-local) once its tab actually
  // resolves — a tree-validated open or a launcher-synthesized draft tab
  // (context-tab-from-draft), never for a dead deep link. Draft-only tabs
  // don't count until Apply clears the marker: their path dies if the
  // draft is discarded, and a remembered dead route would replay on the
  // next visit.
  useLayoutEffect(() => {
    if (
      !activeTab ||
      activeTab.draftOnly ||
      removalState.selection.status !== "bound" ||
      deskRoute.kind !== "owner" ||
      deskRoute.tab.draftOnly ||
      deskRoute.tab.documentId !== removalState.selection.identity.documentId
    )
      return;
    contextRemoval.activate({
      projectId,
      selectionRevision: removalState.selection.revision,
      transitionRevision: removalState.transitionRevision,
      locator: removalState.selection.locator,
      identity: removalState.selection.identity,
      owner: { kind: "desk", documentId: deskRoute.tab.documentId },
    });
  }, [contextRemoval, deskRoute, projectId, removalState]);

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
    const selected = selectedDocumentId
      ? tabs.find((tab) => tab.documentId === selectedDocumentId)
      : null;
    if (selected) {
      void onOpenContextTarget(routeTargetForTab(selected, routeWorkId), { replace: true });
      return;
    }
    const last = removalState.admitted;
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
    removalState.admitted,
    selectedDocumentId,
    tabs,
    onOpenContextTarget,
  ]);

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

  const { catalog: defaultOpenCatalog } = useContextCatalogView(projectId, "manuscript", {
    enabled: wantsDefaultOpen,
    workId: routeWorkId,
  });
  useEffect(() => {
    if (!wantsDefaultOpen || !defaultOpenCatalog) return;
    setWantsDefaultOpen(false);
    // The writer (or a late restore) may have opened something while the
    // tree loaded — an explicit destination always wins over the default.
    if (activeContextScheme !== null || activeContextPath !== null || hasEditorWorkTab) return;
    const file = defaultOpenCatalog.files()[0] ?? null;
    if (file) onSelectContextPath(file.path, "manuscript", { replace: true });
  }, [
    activeContextPath,
    activeContextScheme,
    defaultOpenCatalog,
    hasEditorWorkTab,
    onSelectContextPath,
    wantsDefaultOpen,
  ]);

  useEffect(() => {
    if (!needsRouteTab || routeMaterializationFenced) return;
    if (activeContextScheme === null || activeContextPath === null || !routeCatalog) return;
    const found = routeCatalog.findPath(activeContextPath);
    const file = found?.kind === "file" ? found : null;
    if (!file) return;
    openTab(projectId, contextTabFromFile(activeContextScheme, file, routeWorkId));
  }, [
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
    if (tab.kind === "new" && tab.workId !== routeWorkId) return;
    if (routeWorkId) selectTab(projectId, routeWorkId, documentId);
    if (tab.kind === "new") {
      onSelectContextPath("", "scratch");
      return;
    }
    onSelectContextPath(tab.path, tab.scheme);
  }

  function handleCloseTab(documentId: string) {
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    if (
      tab?.kind !== "new" &&
      tab?.draftOnly &&
      tab.reviewWorkId &&
      tab.reviewDraftId &&
      tab.tabInstanceToken
    ) {
      const item = postApply?.owner
        .getSnapshot()
        .items.find(
          (candidate) =>
            candidate.identity.projectId === projectId &&
            candidate.identity.workId === tab.reviewWorkId &&
            candidate.identity.documentId === documentId &&
            candidate.identity.draftId === tab.reviewDraftId,
        );
      if (item && postApplyCommands) {
        postApplyCommands.abandon({ identity: item.identity, entryVersion: item.entryVersion });
        return;
      }
      if (
        postApply?.owner.draftTabMutationFence({
          identity: {
            accountId: localUntitled.accountId,
            projectId,
            workId: tab.reviewWorkId,
            documentId,
            draftId: tab.reviewDraftId,
          },
          tabInstanceToken: tab.tabInstanceToken,
        }) === "apply-reservation-pending"
      )
        return;
    }
    if (tab?.kind === "new" && !isUntitledPending(projectId, documentId)) {
      const key = {
        accountId: localUntitled.accountId,
        projectId,
        documentId,
      };
      const revision = localUntitled.recordRevision(key);
      contextRemoval.writerClose(projectId, documentId);
      void (async () => {
        if (revision === null) return;
        await new Promise((resolve) => setTimeout(resolve, 0));
        await localUntitled.abandon({
          key,
          expectedRevision: revision,
          evidence: "writer-empty-close",
        });
      })();
      return;
    }
    void contextRemoval.writerClose(projectId, documentId);
  }

  function handleResumeDocument() {
    const last = removalState.admitted;
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
      const tab = getContextTabs(projectId).tabs.find(
        (candidate) => candidate.documentId === documentId,
      );
      if (tab?.kind !== "new") return;
      appendPendingUntitled({
        documentId,
        projectId,
        home: { scheme: "scratch", workId: tab.workId },
      });
    },
    [projectId],
  );

  useUntitledTabBridge({ projectId, tabs });

  return (
    <ContextViewer
      projectId={projectId}
      editorWorkId={routeWorkId}
      tabs={visibleTabs}
      paneState={paneState}
      onSelectTab={handleSelectTab}
      onCloseTab={handleCloseTab}
      sidebarToggle={sidebarToggle}
      dockToggle={dockToggle}
      active={active}
      resumeDocumentName={lastContextRoute ? contextRouteFileName(lastContextRoute.path) : null}
      onResumeDocument={handleResumeDocument}
      onNewDocument={async () => {
        if (!routeWorkId) return;
        const documentId = crypto.randomUUID();
        const opened = await localUntitled.create({
          accountId: localUntitled.accountId,
          projectId,
          documentId,
        });
        if (opened.kind !== "opened") return;
        await openTab(projectId, {
          kind: "new",
          documentId,
          name: "Untitled",
          workId: routeWorkId,
          lineageHandle: opened.value.ref.lineageHandle,
          identityRevision: 1,
        });
        await selectTab(projectId, routeWorkId, documentId);
        onSelectContextPath("", "scratch");
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
        if (
          identityCommitMayNavigate(
            ownership,
            routeWorkId ? getContextTabs(projectId).selectedTabIdByWork[routeWorkId] : undefined,
            documentId,
          )
        ) {
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
