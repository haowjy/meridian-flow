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
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectRouteData } from "@/client/query/project-route-data";
import { useWorks } from "@/client/query/useWorks";
import { useContextTabsStore } from "@/client/stores";
import {
  hydrateWorkingSet,
  retryWorkingSetHydration,
  type WorkingSetHydrationPlan,
} from "@/client/working-set";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  useDraftReviewScopeValue,
} from "@/features/chat/DraftReviewProvider";
import { useReviewProseFocus } from "@/features/chat/review-prose-focus";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { ChatPaneController } from "./ChatPaneController";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import { resolveCatalogWork } from "./catalog-work-resolution";
import { type ChatPlacement, ChatSurface } from "./chat/ChatSurface";
import { useResolvedChatThread } from "./chat/chat-thread-resolution";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { useDockViewStore } from "./dock/dock-view-store";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
} from "./dock/editor-review-handoff";
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
import { WorkPaneController } from "./WorkPaneController";
import {
  type ContextDeskReconciliationScope,
  contextDeskReconciliation,
  seedWorkingSetTabs,
  validateContextDeskTabs,
} from "./working-set-tab-seeding";

/** Minimum width (px) the main content column may shrink to on desktop. */
const MAIN_MIN_WIDTH = 360;
const COMPACT_DESKTOP_QUERY = "(max-width: 899px)";
const NARROW_DESKTOP_QUERY = "(max-width: 767px)";

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
  // The route keys ProjectView by projectId. This initializer therefore runs
  // before any gated child for each project entry; the driver makes a strict-
  // mode replay of the same loader revision an adoption no-op.
  const [entryHydration] = useState<WorkingSetHydrationPlan>(() =>
    hydrateWorkingSet(props.projectId, props.workingSet, props.workingSetSyncEnabled),
  );
  const [retriedHydration, setRetriedHydration] = useState<WorkingSetHydrationPlan | null>(null);
  const workingSetHydration = retriedHydration ?? entryHydration;
  const queryClient = useQueryClient();
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
  const reconciledDeskRef = useRef<string | null>(null);
  const deskReconciliationGenerationRef = useRef(0);
  const liveDeskReconciliationRef = useRef<ContextDeskReconciliationScope | null>(null);
  useEffect(
    () => () => {
      liveDeskReconciliationRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (workingSetHydration.status !== "read-degraded") return;
    const retry = () => {
      void retryWorkingSetHydration(props.projectId).then(setRetriedHydration);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [props.projectId, workingSetHydration.status]);

  useEffect(() => {
    if (!deskHydrated || works === null) return;
    const reconciliation = contextDeskReconciliation(workingSetHydration);
    const reconciliationKey = `${props.projectId}:${reconciliation}:${editorWorkId ?? "no-work"}`;
    if (reconciledDeskRef.current === reconciliationKey) return;
    reconciledDeskRef.current = reconciliationKey;
    const scope = {
      projectId: props.projectId,
      editorWorkId,
      generation: ++deskReconciliationGenerationRef.current,
    };
    liveDeskReconciliationRef.current = scope;
    const isLiveScope = (candidate: ContextDeskReconciliationScope) =>
      liveDeskReconciliationRef.current?.projectId === candidate.projectId &&
      liveDeskReconciliationRef.current.editorWorkId === candidate.editorWorkId &&
      liveDeskReconciliationRef.current.generation === candidate.generation;
    if (reconciliation === "server-replace" && workingSetHydration.status === "server") {
      void seedWorkingSetTabs({
        queryClient,
        routes: workingSetHydration.row.recentRoutes,
        scope,
        isLiveScope,
      });
      return;
    }
    void validateContextDeskTabs({
      queryClient,
      scope,
      isLiveScope,
    });
  }, [editorWorkId, deskHydrated, props.projectId, queryClient, workingSetHydration, works]);
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
      if (!editorWorkId || !scheme) return;
      void props.onOpenContextTarget({ path, scheme, workId: editorWorkId }, options);
    },
    [editorWorkId, props.onOpenContextTarget],
  );
  const resolvedProps = {
    ...props,
    onSelectContextPath: onSelectEditorContextPath,
    activeThreadId: resolvedThreadId,
    chatWork,
    editorScope,
    editorWorkId,
    retryEditorWork: worksQuery.refetch,
    onOpenThread: (threadId: string) => void props.onSelectThread(threadId),
  };
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      {hydrated ? (
        <HydratedReviewProject
          {...resolvedProps}
          chatWorkId={chatWorkId}
          chatThreadId={resolvedThreadId}
        />
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
  editorScope: EditorWorkScope;
  editorWorkId: string | null;
  retryEditorWork: () => void;
  onOpenThread: (threadId: string) => void;
};

export type ReviewScopedProjectProps = ResolvedProjectViewProps & {
  chatReview: DraftReviewContextValue;
  editorReview: DraftReviewContextValue;
};

function HydratedReviewProject({
  chatWorkId,
  chatThreadId,
  ...props
}: ResolvedProjectViewProps & { chatWorkId: string | null; chatThreadId: string | null }) {
  const chatReview = useDraftReviewScopeValue({
    projectId: props.projectId,
    workId: chatWorkId,
    threadId: chatThreadId,
  });
  const editorReview = useDraftReviewScopeValue({
    projectId: props.projectId,
    workId: props.editorWorkId,
    threadId: null,
  });

  return (
    <EditorReviewHandoffProvider
      projectId={props.projectId}
      openContextRoute={props.onOpenContextTarget}
    >
      <HydratedProject {...props} chatReview={chatReview} editorReview={editorReview} />
    </EditorReviewHandoffProvider>
  );
}

function HydratedProject(props: ReviewScopedProjectProps) {
  const usePhone = usePhoneShell();
  if (usePhone === null) return null;
  return usePhone ? <MobileProject {...props} /> : <DesktopProject {...props} />;
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
        props.editorScope.status === "ready" ? (
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
              onClearContextDestination={props.onExitContextScheme}
            />
          </DraftReviewBoundary>
        ) : (
          <EditorWorkRecovery
            scope={props.editorScope}
            onRetry={props.retryEditorWork}
            onOpenWork={() => props.onSelectScreen("work")}
          />
        ),
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
