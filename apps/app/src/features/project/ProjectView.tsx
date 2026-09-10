/**
 * ProjectView — the controlled project workspace shell.
 *
 * Renders the desktop project path (surface layout grid + per-screen pane
 * controller + persistent chat surface) for the active screen. The `$projectId`
 * route owns all navigation state; this shell only distributes route-owned
 * props to focused pane controllers and calls route handlers in response to
 * user actions.
 *
 * The persistent left sidebar owns project file navigation. The Context
 * destination keeps the tab strip and editor/viewer body only.
 */
import { t } from "@lingui/core/macro";
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  type Work,
} from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProjectRouteData } from "@/client/query/project-route-data";
import { useContextCatalogWake } from "@/client/query/useContextCatalog";
import { useWorks } from "@/client/query/useWorks";
import { observeWorksAvailability } from "@/client/query/works-availability-observer";
import { useContextTabs, useContextTabsStore } from "@/client/stores";
import type { ContextTab } from "@/client/stores/context-tabs-store/context-tabs-store";
import {
  hydrateWorkingSet,
  readRecentRoutes,
  retryWorkingSetHydration,
  type WorkingSetHydrationPlan,
} from "@/client/working-set";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReviewScopeValue,
} from "@/features/chat/DraftReviewProvider";
import { inlineReviewFromState } from "@/features/chat/draft-review-session";
import { useReviewProseFocus } from "@/features/chat/review-prose-focus";
import {
  type DraftReviewStateOwner,
  useDraftReviewStateOwner,
} from "@/features/chat/useDraftReviewController";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { ChatPaneController } from "./ChatPaneController";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import { resolveCatalogWork } from "./catalog-work-resolution";
import { type ChatPlacement, ChatSurface } from "./chat/ChatSurface";
import { useResolvedChatThread } from "./chat/chat-thread-resolution";
import {
  useContextRemovalCoordinator,
  useProjectContextAvailabilityCoordinator,
} from "./context/account-feature-context";
import type { ContextRemovalRoutePort } from "./context/context-removal-coordinator";
import { ProjectContextRemovalController } from "./context/ProjectContextRemovalController";
import type { AvailabilityWatchRecord } from "./context/project-context-availability-coordinator";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { useDockViewStore } from "./dock/dock-view-store";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
} from "./dock/editor-review-handoff";
import { ProjectDraftApplyRecoveryExecutor } from "./draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
import { EditorWorkRecovery } from "./EditorWorkRecovery";
import { type EditorWorkScope, resolveEditorWorkScope } from "./editor-work-scope";
import { HomePaneController } from "./HomePaneController";
import {
  type SlotGridSurface,
  SURFACE_WIDTH_BOUNDS,
  type SurfaceId,
  useProjectLayout,
  useProjectSurfacePrefsActions,
  useProjectSurfacePrefsStore,
} from "./layout";
import { MobileProject } from "./mobile/MobileProject";
import {
  type MobileDocumentRoute,
  mobileEditableDocumentId,
  useMobileDocumentRoute,
} from "./mobile/mobile-document-route";
import type {
  ContextRouteTarget,
  ProjectRouteCommands,
  RouteWorkResolution,
} from "./routing/project-route";
import { ContextSidebar } from "./shell/ContextSidebar";
import { LeftSidebar } from "./shell/LeftSidebar";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import { ProjectShell } from "./shell/ProjectShell";
import type { ScreenKey } from "./shell/screens";
import { useContextProjectAuthority } from "./use-context-project-authority";
import { WorkPaneController } from "./WorkPaneController";

/** Minimum width (px) the main content column may shrink to on desktop. */
const MAIN_MIN_WIDTH = 360;
const COMPACT_DESKTOP_QUERY = "(max-width: 899px)";
const NARROW_DESKTOP_QUERY = "(max-width: 767px)";

function availabilityWatchRecord(
  value: Pick<Exclude<ContextTab, { kind: "new" }>, "documentId" | "scheme"> & {
    workId?: string | null;
  },
): AvailabilityWatchRecord {
  return {
    documentId: value.documentId,
    ...(isWorkScopedProjectContextScheme(value.scheme) && value.workId
      ? { sourceWorkId: value.workId }
      : {}),
  };
}

export type ProjectViewProps = {
  projectId: string;
  workingSet: ProjectRouteData["workingSet"];
  workingSetSyncEnabled: boolean;
  /** Resolved screen key from the route (defaults to home). */
  activeScreen: ScreenKey;
  /** Active chat / subagent thread, also used by the persistent dock. */
  activeThreadId: string | null;
  /** Explicit route Work state; loading/error never collapses into absence. */
  routeWork: RouteWorkResolution;
  /** Awaitable route-owner commands used by future collection/detail leaves. */
  routeCommands: ProjectRouteCommands;
  /** Browser route adapter for atomic removal repairs. */
  contextRemovalRoute: ContextRemovalRoutePort;
  /** Active context scheme (manuscript/kb/user/work), when `screen=context`. */
  activeContextScheme: ProjectContextTreeScheme | null;
  /** Active context folder, when `screen=context`. */
  activeContextFolder: string | null;
  /** Active context file path, when `screen=context`. */
  activeContextPath: string | null;
  /** Phone-only routed Results auxiliary surface (`?results=`). Desktop ignores it. */
  resultsOpen: boolean;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectThread: (threadId: string) => Promise<void>;
  onSelectDockThread: (threadId: string) => void;
  onSelectContextScheme: (scheme: ProjectContextTreeScheme) => void;
  onExitContextScheme: () => void;
  onSelectContextFolder: (folder: string) => void;
  /**
   * Selects a context file. When `scheme` is provided, the URL records it.
   */
  onOpenContextTarget: (
    target: ContextRouteTarget,
    options?: { replace?: boolean },
  ) => Promise<void>;
  onOpenResults: () => void;
  onCloseResults: () => void;
};

export function ProjectView(props: ProjectViewProps) {
  const queryClient = useQueryClient();
  const availability = useProjectContextAvailabilityCoordinator();
  const removal = useContextRemovalCoordinator();
  const repairColdWork = useCallback(
    (workId: string) => {
      void availability.coldScopeHint(props.projectId, workId);
    },
    [availability, props.projectId],
  );
  useContextCatalogWake(props.projectId, repairColdWork);
  useEffect(() => {
    const lease = availability.attachProject(props.projectId);
    const reportWatches = () => {
      const slice = useContextTabsStore.getState().byProject[props.projectId];
      lease.watch(
        "server-tabs",
        (slice?.tabs ?? [])
          .filter((tab): tab is Exclude<ContextTab, { kind: "new" }> => tab.kind !== "new")
          .map(availabilityWatchRecord),
      );
      const selection = removal.getProjectSnapshot(props.projectId).selection;
      lease.watch(
        "route-selection",
        selection.status === "bound" && selection.identity.kind === "server"
          ? [
              availabilityWatchRecord({
                documentId: selection.identity.documentId,
                scheme: selection.locator.scheme,
                workId: selection.locator.workId,
              }),
            ]
          : [],
      );
      lease.watch(
        "recent-routes",
        readRecentRoutes(props.projectId).slice(0, 64).map(availabilityWatchRecord),
      );
    };
    reportWatches();
    const stopTabs = useContextTabsStore.subscribe(reportWatches);
    const stopSelection = removal.subscribe(props.projectId, reportWatches);
    const stopWorksObservation = observeWorksAvailability(queryClient, props.projectId);
    return () => {
      stopTabs();
      stopSelection();
      stopWorksObservation();
      lease.release();
    };
  }, [availability, props.projectId, queryClient, removal]);
  // The route keys ProjectView by projectId. This initializer therefore runs
  // before any gated child for each project entry; the driver makes a strict-
  // mode replay of the same loader revision an adoption no-op.
  const [entryHydration] = useState<WorkingSetHydrationPlan>(() =>
    hydrateWorkingSet(props.projectId, props.workingSet, props.workingSetSyncEnabled),
  );
  const [retriedHydration, setRetriedHydration] = useState<WorkingSetHydrationPlan | null>(null);
  const workingSetHydration = retriedHydration ?? entryHydration;
  const { resolvedThreadId, projectThreads } = useResolvedChatThread(
    props.projectId,
    props.activeThreadId,
  );
  const worksQuery = useWorks(props.projectId);
  const { works } = worksQuery;
  const chatWorkId =
    projectThreads?.find((thread) => thread.id === resolvedThreadId)?.workId ?? null;
  const chatWork = works?.find((work) => work.id === chatWorkId) ?? null;
  const catalogWork = resolveCatalogWork(
    worksQuery.status === "error"
      ? { status: "error" }
      : worksQuery.status === "loading" || worksQuery.status === "disabled"
        ? { status: "loading" }
        : { status: "ready", works: works ?? [] },
  );
  const editorScope = resolveEditorWorkScope(props.routeWork, chatWorkId, catalogWork);
  const editorWorkId = editorScope.status === "ready" ? editorScope.workId : null;
  const deskHydrated = useContextTabsStore((s) => s._deskHydrated);
  const contextPhase = useContextProjectAuthority({
    projectId: props.projectId,
    deskHydrated,
    editorScope,
    workingSetHydration,
    queryClient,
  });
  useEffect(() => {
    if (workingSetHydration.status !== "read-degraded") return;
    const retry = () => {
      void retryWorkingSetHydration(props.projectId).then(setRetriedHydration);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [props.projectId, workingSetHydration.status]);

  useEffect(() => {
    if (props.activeScreen !== "chat" || props.activeThreadId || !resolvedThreadId) return;
    props.onSelectThread(resolvedThreadId);
  }, [props.activeScreen, props.activeThreadId, props.onSelectThread, resolvedThreadId]);
  // Gate the whole project on prefs-store hydration so DesktopProject mounts
  // exactly once against final persisted prefs. rehydrate() is synchronous
  // (localStorage), so this is at most one frame — no visible flash. Gating here
  // (not inside DesktopProject) avoids a conditional-hook ordering violation.
  const prefsHydrated = useProjectSurfacePrefsStore((s) => s._hydrated);
  const hydrated = prefsHydrated && deskHydrated;
  const onSelectEditorContextPath = useCallback(
    (path: string, scheme?: ProjectContextTreeScheme, options?: { replace?: boolean }) => {
      if (editorScope.status !== "ready" || !scheme) return;
      void props.onOpenContextTarget({ path, scheme, workId: editorWorkId }, options);
    },
    [editorWorkId, editorScope.status, props.onOpenContextTarget],
  );
  const resolvedProps = {
    ...props,
    onSelectContextPath: onSelectEditorContextPath,
    activeThreadId: resolvedThreadId,
    chatWork,
    availableWorks: works ?? [],
    editorScope,
    editorWorkId,
    retryEditorWork: worksQuery.refetch,
    contextLive: contextPhase.status === "live" && editorScope.status === "ready",
    onOpenThread: (threadId: string) => void props.onSelectThread(threadId),
  };
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      {hydrated ? (
        <>
          {resolvedProps.contextLive ? (
            <ProjectContextRemovalController
              projectId={props.projectId}
              activeScreen={props.activeScreen}
              activeContextScheme={props.activeContextScheme}
              activeContextPath={props.activeContextPath}
              editorWorkId={editorWorkId}
              route={props.contextRemovalRoute}
            />
          ) : null}
          <HydratedReviewProject
            {...resolvedProps}
            chatWorkId={chatWorkId}
            chatThreadId={resolvedThreadId}
          />
        </>
      ) : null}
    </div>
  );
}

export type ResolvedProjectViewProps = ProjectViewProps & {
  onSelectContextPath: (
    path: string,
    scheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  chatWork: Work | null;
  availableWorks: readonly Work[];
  editorScope: EditorWorkScope;
  editorWorkId: string | null;
  retryEditorWork: () => void;
  onOpenThread: (threadId: string) => void;
  contextLive: boolean;
};

export type ReviewScopedProjectProps = ResolvedProjectViewProps & {
  chatReview: DraftReviewContextValue;
  editorReview: DraftReviewContextValue;
  mobileDocumentRoute: MobileDocumentRoute;
};

function HydratedReviewProject({
  chatWorkId,
  chatThreadId,
  ...props
}: ResolvedProjectViewProps & { chatWorkId: string | null; chatThreadId: string | null }) {
  return (
    <EditorReviewHandoffProvider
      projectId={props.projectId}
      openContextRoute={props.onOpenContextTarget}
    >
      <HydratedReviewScopes {...props} chatWorkId={chatWorkId} chatThreadId={chatThreadId} />
    </EditorReviewHandoffProvider>
  );
}

function HydratedReviewScopes({
  chatWorkId,
  chatThreadId,
  ...props
}: ResolvedProjectViewProps & { chatWorkId: string | null; chatThreadId: string | null }) {
  const chatReviewState = useDraftReviewStateOwner();
  const editorReviewState = useDraftReviewStateOwner();
  const usePhone = usePhoneShell();
  const { tabs } = useContextTabs(props.projectId);
  const mobileDocumentRoute = useMobileDocumentRoute({
    enabled:
      usePhone === true &&
      props.activeScreen === "context" &&
      props.contextLive &&
      props.editorScope.status === "ready",
    projectId: props.projectId,
    scheme: props.activeContextScheme,
    path: props.activeContextPath,
    workId: props.editorWorkId,
  });
  const workLabels = useMemo(
    () => Object.fromEntries(props.availableWorks.map((work) => [work.id, work.name])),
    [props.availableWorks],
  );
  if (usePhone === null) return null;
  const desktopHostDocumentIds =
    usePhone || props.editorScope.status !== "ready" || !props.contextLive
      ? []
      : tabs.flatMap((tab) => {
          if (tab.kind !== "tracked") return [];
          if (
            isWorkScopedProjectContextScheme(tab.scheme) &&
            (tab.workId ?? null) !== props.editorWorkId
          )
            return [];
          return [tab.documentId];
        });
  const inlineDocumentIds = [
    inlineReviewFromState(chatReviewState.state)?.documentId,
    inlineReviewFromState(editorReviewState.state)?.documentId,
  ].filter((documentId): documentId is string => Boolean(documentId));
  return (
    <ProjectDraftApplyRecoveryExecutor
      projectId={props.projectId}
      scopeKey={`${chatWorkId ?? ""}:${props.editorWorkId ?? ""}`}
      mobileHostDocumentId={mobileEditableDocumentId(mobileDocumentRoute)}
      inlineDocumentIds={inlineDocumentIds}
      desktopHostDocumentIds={desktopHostDocumentIds}
      workLabels={workLabels}
    >
      <HydratedReviewControllers
        {...props}
        chatWorkId={chatWorkId}
        chatThreadId={chatThreadId}
        chatReviewState={chatReviewState}
        editorReviewState={editorReviewState}
        mobileDocumentRoute={mobileDocumentRoute}
        usePhone={usePhone}
      />
    </ProjectDraftApplyRecoveryExecutor>
  );
}

function HydratedReviewControllers({
  chatWorkId,
  chatThreadId,
  chatReviewState,
  editorReviewState,
  usePhone,
  mobileDocumentRoute,
  ...props
}: ResolvedProjectViewProps & {
  chatWorkId: string | null;
  chatThreadId: string | null;
  chatReviewState: DraftReviewStateOwner;
  editorReviewState: DraftReviewStateOwner;
  usePhone: boolean;
  mobileDocumentRoute: MobileDocumentRoute;
}) {
  const chatReview = useDraftReviewScopeValue({
    projectId: props.projectId,
    workId: chatWorkId,
    owningWorkLabel: props.chatWork?.name ?? null,
    stateOwner: chatReviewState,
    threadId: chatThreadId,
  });
  const editorReview = useDraftReviewScopeValue({
    projectId: props.projectId,
    workId: props.editorWorkId,
    owningWorkLabel:
      props.availableWorks.find((work) => work.id === props.editorWorkId)?.name ?? null,
    stateOwner: editorReviewState,
    threadId: null,
  });
  const scopedProps = { ...props, chatReview, editorReview, mobileDocumentRoute };
  return usePhone ? <MobileProject {...scopedProps} /> : <DesktopProject {...scopedProps} />;
}

/** A PaneHeader expand control derived from a stable surface id. */
function expandToggle(
  surfaceId: SurfaceId,
  open: boolean,
  onSetCollapsed: (surfaceId: SurfaceId, collapsed: boolean) => void,
  label: string,
): PaneHeaderRailToggle {
  return { open, onExpand: () => onSetCollapsed(surfaceId, false), label };
}

/**
 * Desktop layout for every destination. Persistent shell state lives on stable
 * surfaces; per-screen rendering is delegated to pane controllers that receive
 * only the props they need.
 */
function DesktopProject(props: ReviewScopedProjectProps) {
  // Inline review on the Editor screen holds the left rail collapsed to give
  // the manuscript prose width. The hold is derived from review being open and
  // never written to prefs, so the writer's saved rail state returns by itself.
  const proseFocus = useReviewProseFocus(props.activeScreen, props.editorReview);
  // useProjectLayout internally subscribes to prefs + slotPrefs and returns a
  // merged SurfaceLayoutMap; that single subscription drives all layout-driven
  // re-renders — no separate whole-prefs subscription is needed.
  const layout = useProjectLayout(props.activeScreen, proseFocus.collapsedSlots);

  const { setSurfaceCollapsed, setSurfaceWidth, setDockCollapsed, setDockWidth } =
    useProjectSurfacePrefsActions();
  useCompactDesktopAutoCollapse(setDockCollapsed, setSurfaceCollapsed);
  const setDockView = useDockViewStore((state) => state.setDockView);

  // Opening a conversation reveals it where the writer already is. Desktop
  // mounts the chat surface on every screen — centered on Chat, docked on
  // Home/Editor — so a reveal only has to un-park the surface and point it at
  // the thread. `onSelectDockThread` sets `?thread` and leaves `?screen` alone.
  useConversationRevealRouting((threadId) => {
    if (layout.chat.slot === "dock") {
      setDockCollapsed(false);
      setDockView(props.activeScreen, "chat");
    }
    props.onSelectDockThread(threadId);
  });

  const isOpen = (surfaceId: SurfaceId) => !layout[surfaceId].collapsed;
  // The single writer-driven collapse entry. Calls targeting a surface that is
  // currently the dock occupant drive the shared dock pref instead of the
  // surface's own pref — the dock reads as one persistent sidebar across
  // screens. An explicit expand also releases review's hold on the rail, so
  // the control can never write a pref that changes nothing on screen.
  const setCollapsedFor = (surfaceId: SurfaceId, collapsed: boolean) => {
    if (layout[surfaceId].slot === "dock") {
      setDockCollapsed(collapsed);
      return;
    }
    if (!collapsed) proseFocus.release();
    setSurfaceCollapsed(surfaceId, collapsed);
  };
  const close = (surfaceId: SurfaceId) => () => {
    setCollapsedFor(surfaceId, true);
  };
  const surfaceToggle = (surfaceId: SurfaceId, label: string) =>
    expandToggle(surfaceId, isOpen(surfaceId), setCollapsedFor, label);

  const screen = props.activeScreen;
  // The chat is mounted ONCE as a direct child of the project grid, so it
  // never remounts when the destination changes (no reload of the live
  // conversation). It moves center↔dock by changing its wrapper grid-area.
  const chatPlacement: ChatPlacement = screen === "chat" ? "center" : "dock";

  const stableSurfaces: SlotGridSurface[] = [
    {
      id: "threads",
      children: (
        <LeftSidebar
          projectId={props.projectId}
          activeScreen={props.activeScreen}
          editorWorkId={props.editorWorkId}
          contextLive={props.contextLive}
          activeContextScheme={props.activeContextScheme}
          activeContextPath={props.activeContextPath}
          onSelectScreen={props.onSelectScreen}
          onSelectContextPath={props.onSelectContextPath}
          onCollapse={close("threads")}
        />
      ),
    },
    {
      id: "context-rail",
      children: (
        <DraftReviewBoundary value={props.chatReview}>
          <ContextSidebar
            threadId={props.activeThreadId}
            projectId={props.projectId}
            onClose={close("context-rail")}
          />
        </DraftReviewBoundary>
      ),
    },
    {
      id: "context-viewer",
      children:
        props.editorScope.status === "ready" && props.contextLive ? (
          <DraftReviewBoundary value={props.editorReview}>
            <EditorReviewIntentClaimant
              editorWorkId={props.editorWorkId}
              activeScheme={props.activeContextScheme}
              activePath={props.activeContextPath}
            />
            <ContextViewerSurfaceController
              projectId={props.projectId}
              editorWorkId={props.editorWorkId}
              activeContextScheme={props.activeContextScheme}
              activeContextPath={props.activeContextPath}
              active={props.activeScreen === "context"}
              sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
              dockToggle={surfaceToggle("chat", t`Expand chat`)}
              onSelectContextPath={props.onSelectContextPath}
              onOpenContextTarget={props.onOpenContextTarget}
            />
          </DraftReviewBoundary>
        ) : props.editorScope.status !== "ready" ? (
          <EditorWorkRecovery
            scope={props.editorScope}
            onRetry={props.retryEditorWork}
            onOpenWork={() => props.onSelectScreen("work")}
          />
        ) : null,
    },
    {
      id: "chat",
      children: (
        <div
          className="flex min-h-0 flex-1 flex-col"
          role={chatPlacement === "center" ? "main" : undefined}
        >
          {/* Stable keys pin chat-surface identity so toggling this header
              controller never risks reconciling the live conversation subtree. */}
          {chatPlacement === "center" ? (
            <ChatPaneController
              key="chat-pane-controller"
              projectId={props.projectId}
              threadId={props.activeThreadId}
              sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
              contextToggle={surfaceToggle("context-rail", t`Expand context`)}
              onSelectThread={props.onSelectThread}
            />
          ) : null}
          {/* This keyed surface remains the same mounted element when its slot
              moves between center and dock; placement changes only its chrome. */}
          <DraftReviewBoundary value={props.chatReview}>
            <ChatSurface
              key="chat-surface"
              projectId={props.projectId}
              threadId={props.activeThreadId}
              activeWork={props.chatWork}
              availableWorks={props.availableWorks}
              activeScreen={screen}
              // Centered chat owns the route (`?screen` follows it); the dock must
              // only change which conversation it shows, never the screen — so it
              // uses onSelectDockThread (sets `?thread`, keeps `?screen`).
              onSelectThread={
                chatPlacement === "center" ? props.onSelectThread : props.onSelectDockThread
              }
              placement={chatPlacement}
              // Mounted-but-hidden when the dock is collapsed, so the live
              // conversation survives a close/reopen.
              visible={chatPlacement === "center" || isOpen("chat")}
              onCloseDock={close("chat")}
              onOpenContextTarget={props.onOpenContextTarget}
            />
          </DraftReviewBoundary>
        </div>
      ),
    },
  ];

  return (
    <TreeCreationProvider expandSidebar={() => setCollapsedFor("threads", false)}>
      <ProjectShell
        layout={layout}
        surfaces={stableSurfaces}
        onSetWidth={setSurfaceWidth}
        onSetCollapsed={setCollapsedFor}
        onSetDockWidth={setDockWidth}
        onSetDockCollapsed={setDockCollapsed}
        bounds={SURFACE_WIDTH_BOUNDS}
        mainMinWidth={MAIN_MIN_WIDTH}
      >
        {renderDesktopPane(props, surfaceToggle)}
      </ProjectShell>
    </TreeCreationProvider>
  );
}

type SurfaceToggleFactory = (surfaceId: SurfaceId, label: string) => PaneHeaderRailToggle;

function renderDesktopPane(props: ResolvedProjectViewProps, surfaceToggle: SurfaceToggleFactory) {
  switch (props.activeScreen) {
    case "home":
      return (
        <HomePaneController
          projectId={props.projectId}
          sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
          chatToggle={surfaceToggle("chat", t`Expand chat`)}
          onSelectThread={props.onSelectThread}
          onOpenThread={props.onOpenThread}
        />
      );
    case "work":
      return (
        <WorkPaneController
          projectId={props.projectId}
          routeWork={props.routeWork}
          routeCommands={props.routeCommands}
          onOpenThread={props.onOpenThread}
          sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
          chatToggle={surfaceToggle("chat", t`Expand chat`)}
        />
      );
    case "chat":
      return null;
    case "context":
      // Context owns no destination header — the tab strip absorbs the
      // sidebar/dock expand toggles. See `ContextViewer`.
      return null;
  }
}

/**
 * Collapse chrome once when entering compact desktop widths. The listener only
 * runs on mount/media-boundary changes, so a user can re-expand rails without
 * the effect immediately fighting that preference.
 */
function useCompactDesktopAutoCollapse(
  setDockCollapsed: (collapsed: boolean) => void,
  setSurfaceCollapsed: (surfaceId: SurfaceId, collapsed: boolean) => void,
) {
  useEffect(() => {
    const compact = window.matchMedia(COMPACT_DESKTOP_QUERY);
    const narrow = window.matchMedia(NARROW_DESKTOP_QUERY);
    const apply = () => {
      if (compact.matches) setDockCollapsed(true);
      if (narrow.matches) setSurfaceCollapsed("threads", true);
    };
    compact.addEventListener("change", apply);
    narrow.addEventListener("change", apply);
    apply();
    return () => {
      compact.removeEventListener("change", apply);
      narrow.removeEventListener("change", apply);
    };
  }, [setDockCollapsed, setSurfaceCollapsed]);
}
