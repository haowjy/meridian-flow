/**
 * ContextPaneController — desktop SURFACE controller for the route-owned
 * Context destination.
 *
 * Purpose: own route reconciliation, tab mutations, and scroll restoration
 * for the Editor destination. The project sidebar owns the file tree; this
 * controller owns only the persistent tab/document surface.
 */
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useContextWorkId } from "@/client/query/useContextWorkId";
import { useProjectContextTree } from "@/client/query/useProjectContextTree";
import {
  isEmptyTempDocument,
  useContextTabs,
  useContextTabsActions,
  useTempDocsStore,
} from "@/client/stores";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { ContextViewer } from "./context/ContextViewer";
import {
  type LastContextRoute,
  readLastContextRoute,
  saveLastContextRoute,
} from "./context/context-last-route";
import { contextTabFromFile } from "./context/context-tab-from-file";
import { contextTabRouteKey, findContextTabForRoute } from "./context/context-tab-identity";
import { findContextFile } from "./context/context-tree";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";

const EMPTY_TEMP_DOCUMENTS: import("@/client/stores").TempDocument[] = [];

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
  const { tabs: serverTabs, activeTabId } = useContextTabs(projectId);
  const tempDocuments = useTempDocsStore(
    (state) => state.byProject[projectId] ?? EMPTY_TEMP_DOCUMENTS,
  );
  const createTemp = useTempDocsStore((state) => state.createTemp);
  const removeTemp = useTempDocsStore((state) => state.removeTemp);
  const [pendingDiscardId, setPendingDiscardId] = useState<string | null>(null);
  const tempTabs = tempDocuments.map((document) => ({
    kind: "temp" as const,
    documentId: document.id,
    name: document.name,
    document,
  }));
  const tabs = [...serverTabs, ...tempTabs];
  const { openTab, closeTab, pruneWorkScopedTabs, selectTab } = useContextTabsActions();
  const activeTab = findContextTabForRoute(tabs, activeContextScheme, activeContextPath, workId);
  const [rememberedRoute, setRememberedRoute] = useState<{
    projectId: string;
    route: LastContextRoute;
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
  const previousRouteStateRef = useRef({ tabs: serverTabs, activeTab });

  useEffect(() => {
    previousRouteStateRef.current = { tabs: serverTabs, activeTab };
  }, [projectId, workId]);

  useEffect(() => {
    pruneWorkScopedTabs(projectId, workId);
  }, [projectId, pruneWorkScopedTabs, workId]);

  useEffect(() => {
    if (activeTab) selectTab(projectId, activeTab.documentId);
  }, [activeTab, projectId, selectTab]);

  // Device-local routes are unavailable during SSR. Read after hydration so
  // the server and first client render agree, then mirror persistence writes.
  useEffect(() => {
    const route = readLastContextRoute(projectId);
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
    const route = { scheme: activeTab.scheme, path: activeTab.path };
    saveLastContextRoute(projectId, route);
    setRememberedRoute({ projectId, route });
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
    saveLastContextRoute(projectId, null);
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
    if (tempDocuments.some((document) => document.id === documentId)) {
      selectTab(projectId, documentId);
      onSelectContextPath("", activeContextScheme ?? undefined);
      return;
    }
    const tab = tabs.find((candidate) => candidate.documentId === documentId);
    if (!tab || tab.kind === "temp") return;
    selectTab(projectId, documentId);
    onSelectContextPath(tab.path, tab.scheme);
  }

  function handleCloseTab(documentId: string) {
    const temp = tempDocuments.find((document) => document.id === documentId);
    if (temp) {
      if (!isEmptyTempDocument(temp)) {
        setPendingDiscardId(documentId);
        return;
      }
      removeTemp(projectId, documentId);
      if (activeTabId === documentId) selectTab(projectId, null);
      return;
    }
    const closedWasActive = documentId === activeTabId;
    const fallback = closeTab(projectId, documentId);
    // Closing the last tab is a deliberate "empty desk" — forget the
    // remembered file so it doesn't resurrect on the next visit.
    if (!fallback) {
      saveLastContextRoute(projectId, null);
      setRememberedRoute(null);
    }
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

  function handleResumeDocument() {
    const last = readLastContextRoute(projectId);
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

  const discardPendingTemp = () => {
    if (!pendingDiscardId) return;
    removeTemp(projectId, pendingDiscardId);
    if (activeTabId === pendingDiscardId) selectTab(projectId, null);
    setPendingDiscardId(null);
  };

  return (
    <>
      <ContextViewer
        projectId={projectId}
        activeThreadId={activeThreadId}
        tabs={tabs}
        activeTabId={retainedActiveTabId}
        onSelectTab={handleSelectTab}
        onCloseTab={handleCloseTab}
        sidebarToggle={sidebarToggle}
        dockToggle={dockToggle}
        active={active}
        resumeDocumentName={lastContextRoute ? contextRouteName(lastContextRoute.path) : null}
        onResumeDocument={handleResumeDocument}
        onNewTemp={() => {
          const document = createTemp(projectId);
          selectTab(projectId, document.id);
          onSelectContextPath("", activeContextScheme ?? undefined);
        }}
        onTempOpenSaved={(scheme, path) => {
          onSelectContextPath(path, scheme);
        }}
        onTempVerificationFailed={(documentId) => selectTab(projectId, documentId)}
      />
      <Dialog
        open={pendingDiscardId !== null}
        onOpenChange={(open) => !open && setPendingDiscardId(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              <Trans>Discard this document?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>It was never saved to your project. Its words will be gone.</Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDiscardId(null)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button variant="destructive" size="sm" onClick={discardPendingTemp}>
              <Trans>Discard</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
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
