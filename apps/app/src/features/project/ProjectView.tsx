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
import {
  cancelOpenAcknowledgementTransfer,
  type OpenAcknowledgementTransfer,
  prepareHomeOpenAcknowledgement,
} from "@/client/query/visible-thread-open-acknowledgements";
import { useContextTabsStore } from "@/client/stores";
import {
  hydrateWorkingSet,
  retryWorkingSetHydration,
  type WorkingSetHydrationPlan,
} from "@/client/working-set";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import { DraftReviewProvider } from "@/features/chat/DraftReviewProvider";
import { useReviewProseFocus } from "@/features/chat/review-prose-focus";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { ChatPaneController } from "./ChatPaneController";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import { type ChatPlacement, ChatSurface } from "./chat/ChatSurface";
import { useResolvedChatThread } from "./chat/chat-thread-resolution";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { useDockViewStore } from "./dock/dock-view-store";
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
import { ContextSidebar } from "./shell/ContextSidebar";
import { LeftSidebar } from "./shell/LeftSidebar";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import { ProjectShell } from "./shell/ProjectShell";
import type { ScreenKey } from "./shell/screens";
import { WorkPaneController } from "./WorkPaneController";
import {
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
  onSelectContextPath: (
    path: string,
    scheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
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
  const [pendingOpen, setPendingOpen] = useState<{
    transfer: OpenAcknowledgementTransfer;
    navigationSettled: boolean;
  } | null>(null);
  const pendingOpenRef = useRef(pendingOpen);
  pendingOpenRef.current = pendingOpen;
  const cancelPendingOpen = useCallback(
    (transfer: OpenAcknowledgementTransfer) => {
      cancelOpenAcknowledgementTransfer(queryClient, transfer);
      if (pendingOpenRef.current?.transfer === transfer) pendingOpenRef.current = null;
      setPendingOpen((current) => (current?.transfer === transfer ? null : current));
    },
    [queryClient],
  );
  const onOpenThread = useCallback(
    (threadId: string) => {
      const previous = pendingOpenRef.current;
      if (previous) cancelPendingOpen(previous.transfer);
      const offer = prepareHomeOpenAcknowledgement(queryClient, {
        projectId: props.projectId,
        threadId,
      });
      if (offer.kind === "transfer") {
        const pending = { transfer: offer.transfer, navigationSettled: false };
        pendingOpenRef.current = pending;
        setPendingOpen(pending);
      }
      void props.onSelectThread(threadId).then(
        () => {
          if (offer.kind === "transfer") {
            setPendingOpen((current) => {
              if (current?.transfer !== offer.transfer) return current;
              const settled = { transfer: offer.transfer, navigationSettled: true };
              pendingOpenRef.current = settled;
              return settled;
            });
          }
        },
        () => {
          if (offer.kind === "transfer") cancelPendingOpen(offer.transfer);
        },
      );
    },
    [cancelPendingOpen, props.onSelectThread, props.projectId, queryClient],
  );
  const onOpenTransferClaimed = useCallback((transfer: OpenAcknowledgementTransfer) => {
    if (pendingOpenRef.current?.transfer === transfer) pendingOpenRef.current = null;
    setPendingOpen((current) => (current?.transfer === transfer ? null : current));
  }, []);
  useEffect(() => {
    if (!pendingOpen?.navigationSettled) return;
    const { transfer } = pendingOpen;
    if (
      transfer.key.projectId !== props.projectId ||
      transfer.key.threadId !== props.activeThreadId ||
      props.activeScreen !== "chat"
    ) {
      cancelPendingOpen(transfer);
    }
  }, [cancelPendingOpen, pendingOpen, props.activeScreen, props.activeThreadId, props.projectId]);
  useEffect(
    () => () => {
      const current = pendingOpenRef.current;
      if (current) cancelOpenAcknowledgementTransfer(queryClient, current.transfer);
    },
    [queryClient],
  );
  const { resolvedThreadId, projectThreads } = useResolvedChatThread(
    props.projectId,
    props.activeThreadId,
  );
  const { works } = useWorks(props.projectId);
  const workId = projectThreads?.find((thread) => thread.id === resolvedThreadId)?.workId ?? null;
  const activeWork = works?.find((work) => work.id === workId) ?? null;
  const deskHydrated = useContextTabsStore((s) => s._deskHydrated);
  const reconciledDeskRef = useRef<string | null>(null);
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
    const reconciliationKey = `${props.projectId}:${reconciliation}:${activeWork?.id ?? "no-work"}`;
    if (reconciledDeskRef.current === reconciliationKey) return;
    reconciledDeskRef.current = reconciliationKey;
    if (reconciliation === "server-replace" && workingSetHydration.status === "server") {
      void seedWorkingSetTabs({
        queryClient,
        projectId: props.projectId,
        routes: workingSetHydration.row.recentRoutes,
        routeWorkId: activeWork?.id ?? null,
      });
      return;
    }
    void validateContextDeskTabs({
      queryClient,
      projectId: props.projectId,
      routeWorkId: activeWork?.id ?? null,
    });
  }, [activeWork?.id, deskHydrated, props.projectId, queryClient, workingSetHydration, works]);
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
  const resolvedProps = {
    ...props,
    activeThreadId: resolvedThreadId,
    activeWork,
    onOpenThread,
    openTransfer: pendingOpen?.transfer,
    onOpenTransferClaimed,
  };
  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      {hydrated ? (
        <DraftReviewProvider
          projectId={props.projectId}
          workId={activeWork?.id ?? null}
          threadId={resolvedThreadId}
        >
          <HydratedProject {...resolvedProps} />
        </DraftReviewProvider>
      ) : null}
    </div>
  );
}

export type ResolvedProjectViewProps = ProjectViewProps & {
  activeWork: Work | null;
  onOpenThread: (threadId: string) => void;
  openTransfer?: OpenAcknowledgementTransfer;
  onOpenTransferClaimed: (transfer: OpenAcknowledgementTransfer) => void;
};

function HydratedProject(props: ResolvedProjectViewProps) {
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
function DesktopProject(props: ResolvedProjectViewProps) {
  // Inline review on the Editor screen holds the left rail collapsed to give
  // the manuscript prose width. The hold is derived from review being open and
  // never written to prefs, so the writer's saved rail state returns by itself.
  const proseFocus = useReviewProseFocus(props.activeScreen);
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
          activeThreadId={props.activeThreadId}
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
        <ContextSidebar
          threadId={props.activeThreadId}
          projectId={props.projectId}
          onClose={close("context-rail")}
        />
      ),
    },
    {
      id: "context-viewer",
      children: (
        <ContextViewerSurfaceController
          projectId={props.projectId}
          activeThreadId={props.activeThreadId}
          activeContextScheme={props.activeContextScheme}
          activeContextPath={props.activeContextPath}
          active={props.activeScreen === "context"}
          sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
          dockToggle={surfaceToggle("chat", t`Expand chat`)}
          onSelectContextPath={props.onSelectContextPath}
          onClearContextDestination={props.onExitContextScheme}
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
          <ChatSurface
            key="chat-surface"
            projectId={props.projectId}
            threadId={props.activeThreadId}
            activeWork={props.activeWork}
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
            openTransfer={props.openTransfer}
            onOpenTransferClaimed={props.onOpenTransferClaimed}
            onCloseDock={close("chat")}
            onSelectContextPath={props.onSelectContextPath}
          />
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
