/**
 * ProjectView — the controlled project workspace shell.
 *
 * Renders the desktop project path (surface layout grid + per-screen pane
 * controller + persistent chat surface) for the active screen. The readable
 * project route owns all navigation state; this shell distributes route-owned
 * props to focused pane controllers and calls route handlers in response to
 * user actions. Chat commands (open, new, index) are not threaded as props —
 * leaves read them from `useChatNavigation()`, the one place that owns them.
 *
 * The persistent left sidebar owns project file navigation. The Context
 * destination keeps the tab strip and editor/viewer body only.
 */

import { t } from "@lingui/core/macro";
import type { Project } from "@meridian/contracts/projects";
import {
  isWorkScopedProjectContextScheme,
  type ProjectContextTreeScheme,
  type Work,
} from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { updateProject } from "@/client/api/projects-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import type { ProjectRouteData } from "@/client/query/project-route-data";
import { useContextCatalogWake } from "@/client/query/useContextCatalog";
import { useProject } from "@/client/query/useProjectList";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { observeWorksAvailability } from "@/client/query/works-availability-observer";
import {
  patchAccountRecentsFromTabs,
  readAccountRecents,
  subscribeAccountRecents,
} from "@/client/recents";
import { useContextTabs, useContextTabsStore } from "@/client/stores";
import type { ContextTab } from "@/client/stores/context-tabs-store/context-tabs-store";
import {
  readRecentRoutes,
  retryWorkingSetHydration,
  type WorkingSetHydrationPlan,
} from "@/client/working-set";
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
import { ChatIndexController } from "./ChatIndexController";
import { ChatPaneController } from "./ChatPaneController";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import { type ChatPlacement, ChatSurface } from "./chat/ChatSurface";
import {
  useAccountId,
  useContextRemovalCoordinator,
  useProjectContextAvailabilityCoordinator,
} from "./context/account-feature-context";
import type { ContextRemovalRoutePort } from "./context/context-removal-coordinator";
import { ProjectContextRemovalController } from "./context/ProjectContextRemovalController";
import type { AvailabilityWatchRecord } from "./context/project-context-availability-coordinator";
import { recentAddressFromTab } from "./context/recent-opening";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { useDockViewStore } from "./dock/dock-view-store";
import {
  EditorReviewHandoffProvider,
  EditorReviewIntentClaimant,
} from "./dock/editor-review-handoff";
import { ProjectDraftApplyRecoveryExecutor } from "./draft-apply-recovery/ProjectDraftApplyRecoveryExecutor";
import { EditorWorkRecovery } from "./EditorWorkRecovery";
import { type EditorWorkScope, resolveEditorWorkScope } from "./editor-work-scope";
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
import {
  type ChatDisplay,
  chatSurfaceThreadId,
  displayedChatThreadId,
  useDockReveal,
} from "./routing/chat-navigation";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import { ProjectRouteBoundary, type ProjectRouteIssue } from "./routing/ProjectRouteBoundary";
import type { ProjectRouteCommands, RouteWorkResolution } from "./routing/project-route";
import { ContextSidebar } from "./shell/ContextSidebar";
import type { ProjectTitleEdit } from "./shell/InlineProjectTitle";
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
  /** Full route-loaded project, used before the account list query is ready. */
  project: Project;
  workingSet: ProjectRouteData["workingSet"];
  workingSetSyncEnabled: boolean;
  /** Resolved screen key from the route (defaults to Chat). */
  activeScreen: ScreenKey;
  /** What the Chat screen or the dock currently shows for chat. */
  chatDisplay: ChatDisplay;
  /** Explicit route Work state; loading/error never collapses into absence. */
  routeWork: RouteWorkResolution;
  editorRouteWork?: RouteWorkResolution;
  activeLocalDocumentId?: string;
  entryHydration: WorkingSetHydrationPlan;
  addressOwnsDocumentAdmission?: boolean;
  routeLocationKey?: string;
  routeIssues?: { main?: ProjectRouteIssue; editor?: ProjectRouteIssue };
  onDisplayedSelection?: (selection: { editorWorkId: string | null }) => void;
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
  onSelectContextScheme: (scheme: ProjectContextTreeScheme) => void;
  onExitContextScheme: () => void;
  onSelectContextFolder: (folder: string) => void;
  /**
   * Selects a context file. When `scheme` is provided, the URL records it.
   */
  onOpenContextTarget: OpenContextRoute;
  onOpenResults: () => void;
  onCloseResults: () => void;
};

export function ProjectView(props: ProjectViewProps) {
  const queryClient = useQueryClient();
  const cachedProject = useProject(props.projectId);
  const projectTitle = cachedProject?.title ?? props.project.title;
  const renameProject = useMutation({
    mutationKey: projectQueryKeys.rename(props.projectId),
    mutationFn: (title: string) => updateProject(props.projectId, { title }),
    onMutate: async (title) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: projectQueryKeys.list }),
        queryClient.cancelQueries({ queryKey: projectQueryKeys.detail(props.projectId) }),
      ]);
      const list = queryClient.getQueryData<Project[] | null>(projectQueryKeys.list);
      const detail = queryClient.getQueryData<Project>(projectQueryKeys.detail(props.projectId));
      const previousRow = list?.find((project) => project.id === props.projectId);
      const optimistic = (project: Project): Project => ({ ...project, title, name: title });
      queryClient.setQueryData<Project[] | null>(projectQueryKeys.list, (current) =>
        (current ?? [props.project]).map((project) =>
          project.id === props.projectId ? optimistic(project) : project,
        ),
      );
      if (detail)
        queryClient.setQueryData(projectQueryKeys.detail(props.projectId), optimistic(detail));
      return { previousRow, detail };
    },
    onError: (_error, _title, previous) => {
      if (!previous) return;
      queryClient.setQueryData<Project[] | null>(projectQueryKeys.list, (current) =>
        current?.flatMap((project) =>
          project.id === props.projectId
            ? previous.previousRow
              ? [previous.previousRow]
              : []
            : [project],
        ),
      );
      if (previous.detail)
        queryClient.setQueryData(projectQueryKeys.detail(props.projectId), previous.detail);
    },
    onSuccess: async (project) => {
      // A list read started while the mutation was pending may return an old
      // title after PATCH succeeds. Fence it before publishing confirmation.
      await queryClient.cancelQueries({ queryKey: projectQueryKeys.list });
      queryClient.setQueryData<Project[] | null>(projectQueryKeys.list, (list) =>
        list?.map((item) => (item.id === project.id ? project : item)),
      );
      queryClient.setQueryData(projectQueryKeys.detail(props.projectId), project);
    },
  });
  const accountId = useAccountId();
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
      const tabs = slice?.tabs ?? [];
      patchAccountRecentsFromTabs(
        accountId,
        props.projectId,
        tabs.flatMap((tab) => {
          const address = recentAddressFromTab(tab);
          return address ? [{ documentId: tab.documentId, name: tab.name, address }] : [];
        }),
      );
      lease.watch(
        "account-recents",
        readAccountRecents(props.projectId).flatMap((item) =>
          item.address.kind === "document"
            ? [
                availabilityWatchRecord({
                  documentId: item.documentId,
                  scheme: item.address.scheme,
                }),
              ]
            : [],
        ),
      );
    };
    reportWatches();
    const stopTabs = useContextTabsStore.subscribe(reportWatches);
    const stopSelection = removal.subscribe(props.projectId, reportWatches);
    const stopRecents = subscribeAccountRecents(reportWatches);
    const stopWorksObservation = observeWorksAvailability(queryClient, props.projectId);
    return () => {
      stopTabs();
      stopSelection();
      stopRecents();
      stopWorksObservation();
      lease.release();
    };
  }, [accountId, availability, props.projectId, queryClient, removal]);
  const [retriedHydration, setRetriedHydration] = useState<WorkingSetHydrationPlan | null>(null);
  const workingSetHydration = retriedHydration ?? props.entryHydration;
  const { threads: projectThreads } = useProjectThreads(props.projectId);
  const worksQuery = useWorks(props.projectId);
  const { works, noWork } = worksQuery;
  // The index shows nothing chat-scoped: the rail and the draft review scope
  // both go to null there, even though the current chat stays warm behind it.
  const displayedChatThread = displayedChatThreadId(props.chatDisplay);
  const chatThread = projectThreads?.find((thread) => thread.id === displayedChatThread);
  const chatWork = chatThread
    ? workFromSnapshot(noWork ? { works: works ?? [], noWork } : null, chatThread.workId ?? null)
    : null;
  const chatWorkId = chatWork?.id ?? null;
  const editorScope = resolveEditorWorkScope(props.editorRouteWork ?? props.routeWork);
  const editorWorkId = editorScope.status === "ready" ? editorScope.workId : null;
  useLayoutEffect(() => {
    props.onDisplayedSelection?.({ editorWorkId });
  }, [props.onDisplayedSelection, editorWorkId]);
  const workspaceHydrated = useContextTabsStore((s) => s._workspaceHydrated);
  const contextPhase = useContextProjectAuthority({
    projectId: props.projectId,
    workspaceHydrated,
    editorScope,
  });
  useEffect(() => {
    if (workingSetHydration.status !== "read-degraded") return;
    const retry = () => {
      void retryWorkingSetHydration(props.projectId).then(setRetriedHydration);
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [props.projectId, workingSetHydration.status]);

  // Gate the whole project on prefs-store hydration so DesktopProject mounts
  // exactly once against final persisted prefs. rehydrate() is synchronous
  // (localStorage), so this is at most one frame — no visible flash. Gating here
  // (not inside DesktopProject) avoids a conditional-hook ordering violation.
  const prefsHydrated = useProjectSurfacePrefsStore((s) => s._hydrated);
  const hydrated = prefsHydrated && workspaceHydrated;
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
    chatWork,
    chatWorkId,
    // The review scope's thread: the displayed chat, null on the index.
    chatThreadId: displayedChatThread,
    availableWorks: works ?? [],
    editorScope,
    editorWorkId,
    retryEditorWork: worksQuery.refetch,
    contextLive: contextPhase.status === "live" && editorScope.status === "ready",
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
              localDocumentId={props.activeLocalDocumentId}
              route={props.contextRemovalRoute}
            />
          ) : null}
          <HydratedReviewProject
            {...resolvedProps}
            projectTitle={projectTitle}
            titleEdit={{
              pending: renameProject.isPending,
              error: renameProject.error,
              onStart: () => renameProject.reset(),
              onSave: (title) => renameProject.mutateAsync(title),
            }}
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
  /** The draft review scope's Work: the displayed chat's Work, null on the index. */
  chatWorkId: string | null;
  /** The draft review scope's thread: the displayed chat, null on the index. */
  chatThreadId: string | null;
  availableWorks: readonly Work[];
  editorScope: EditorWorkScope;
  editorWorkId: string | null;
  retryEditorWork: () => void;
  contextLive: boolean;
};

type ProjectIdentityProps = { projectTitle: string; titleEdit: ProjectTitleEdit };

export type ReviewScopedProjectProps = ResolvedProjectViewProps &
  ProjectIdentityProps & {
    chatReview: DraftReviewContextValue;
    editorReview: DraftReviewContextValue;
    mobileDocumentRoute: MobileDocumentRoute;
    retainEditorWhileLoading?: boolean;
  };

type MobileEditorPresentation = Pick<
  ResolvedProjectViewProps,
  "activeContextScheme" | "activeContextPath" | "activeContextFolder" | "activeLocalDocumentId"
> & { mobileDocumentRoute: MobileDocumentRoute };

function HydratedReviewProject(props: ResolvedProjectViewProps & ProjectIdentityProps) {
  return (
    <EditorReviewHandoffProvider
      projectId={props.projectId}
      openContextRoute={props.onOpenContextTarget}
    >
      <HydratedReviewScopes {...props} />
    </EditorReviewHandoffProvider>
  );
}

function HydratedReviewScopes(props: ResolvedProjectViewProps & ProjectIdentityProps) {
  const chatReviewState = useDraftReviewStateOwner();
  const editorReviewState = useDraftReviewStateOwner();
  const usePhone = usePhoneShell();
  const { tabs } = useContextTabs(props.projectId);
  const requestedMobileDocumentRoute = useMobileDocumentRoute({
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
  const priorMobile = useRef<{
    projectId: string;
    workId: string | null;
    presentation: MobileEditorPresentation;
  } | null>(null);
  const retainEditorWhileLoading =
    usePhone === true &&
    props.activeScreen === "context" &&
    !props.resultsOpen &&
    props.editorScope.status === "ready" &&
    props.routeIssues?.editor === "loading" &&
    priorMobile.current?.projectId === props.projectId &&
    priorMobile.current.workId === props.editorWorkId;
  const retainedPresentation = retainEditorWhileLoading ? priorMobile.current?.presentation : null;
  const displayedProps = retainedPresentation ? { ...props, ...retainedPresentation } : props;
  const mobileDocumentRoute =
    retainedPresentation?.mobileDocumentRoute ?? requestedMobileDocumentRoute;
  useLayoutEffect(() => {
    if (
      usePhone === true &&
      props.activeScreen === "context" &&
      !props.resultsOpen &&
      props.editorScope.status === "ready" &&
      !props.routeIssues?.editor &&
      (props.activeContextPath || props.activeLocalDocumentId)
    ) {
      priorMobile.current = {
        projectId: props.projectId,
        workId: props.editorWorkId,
        presentation: {
          activeContextScheme: props.activeContextScheme,
          activeContextPath: props.activeContextPath,
          activeContextFolder: props.activeContextFolder,
          activeLocalDocumentId: props.activeLocalDocumentId,
          mobileDocumentRoute: requestedMobileDocumentRoute,
        },
      };
    } else if (!retainEditorWhileLoading) {
      priorMobile.current = null;
    }
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
      scopeKey={`${props.chatWorkId ?? ""}:${props.editorWorkId ?? ""}`}
      mobileHostDocumentId={mobileEditableDocumentId(mobileDocumentRoute)}
      inlineDocumentIds={inlineDocumentIds}
      desktopHostDocumentIds={desktopHostDocumentIds}
      workLabels={workLabels}
    >
      <HydratedReviewControllers
        {...displayedProps}
        retainEditorWhileLoading={retainEditorWhileLoading}
        chatReviewState={chatReviewState}
        editorReviewState={editorReviewState}
        mobileDocumentRoute={mobileDocumentRoute}
        usePhone={usePhone}
      />
    </ProjectDraftApplyRecoveryExecutor>
  );
}

function HydratedReviewControllers({
  chatReviewState,
  editorReviewState,
  usePhone,
  mobileDocumentRoute,
  ...props
}: ResolvedProjectViewProps & {
  projectTitle: string;
  titleEdit: ProjectTitleEdit;
  chatReviewState: DraftReviewStateOwner;
  editorReviewState: DraftReviewStateOwner;
  usePhone: boolean;
  mobileDocumentRoute: MobileDocumentRoute;
  retainEditorWhileLoading?: boolean;
}) {
  const chatReview = useDraftReviewScopeValue({
    projectId: props.projectId,
    workId: props.chatWorkId,
    owningWorkLabel: props.chatWork?.name ?? null,
    stateOwner: chatReviewState,
    threadId: props.chatThreadId,
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
export function DesktopProject(props: ReviewScopedProjectProps) {
  const priorEditor = useRef<Pick<
    ReviewScopedProjectProps,
    | "editorReview"
    | "editorWorkId"
    | "activeContextScheme"
    | "activeContextPath"
    | "activeLocalDocumentId"
  > | null>(null);
  const editorActive =
    props.activeScreen === "context" &&
    props.editorScope.status === "ready" &&
    props.contextLive &&
    !props.routeIssues?.editor;
  const mountedEditor = editorActive ? props : priorEditor.current;
  useLayoutEffect(() => {
    if (editorActive) priorEditor.current = props;
  });

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

  useDockReveal(() => {
    setDockCollapsed(false);
    setDockView(props.activeScreen, "chat");
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
  const chatIndexShowing = chatPlacement === "center" && props.chatDisplay.kind === "index";
  // Warm behind the index too: the persistent surface always tracks the
  // display's underlying thread, not just what is on screen right now.
  const chatSurfaceThread = chatSurfaceThreadId(props.chatDisplay);

  const stableSurfaces: SlotGridSurface[] = [
    {
      id: "threads",
      children: (
        <LeftSidebar
          projectId={props.projectId}
          projectTitle={props.projectTitle}
          titleEdit={props.titleEdit}
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
            threadId={displayedChatThreadId(props.chatDisplay)}
            projectId={props.projectId}
            onClose={close("context-rail")}
          />
        </DraftReviewBoundary>
      ),
    },
    {
      id: "context-viewer",
      children: (
        <ProjectRouteBoundary
          destinationKey={props.routeLocationKey}
          issue={props.editorScope.status === "ready" ? props.routeIssues?.editor : undefined}
          retainWhileLoading={
            !!priorEditor.current && priorEditor.current.editorWorkId === props.editorWorkId
          }
          recovery={
            props.editorScope.status !== "ready" ? (
              <EditorWorkRecovery scope={props.editorScope} onRetry={props.retryEditorWork} />
            ) : undefined
          }
        >
          {mountedEditor ? (
            <DraftReviewBoundary value={mountedEditor.editorReview}>
              {editorActive ? (
                <EditorReviewIntentClaimant
                  editorWorkId={props.editorWorkId}
                  activeScheme={props.activeContextScheme}
                  activePath={props.activeContextPath}
                />
              ) : null}
              <ContextViewerSurfaceController
                projectId={props.projectId}
                editorWorkId={mountedEditor.editorWorkId}
                activeContextScheme={mountedEditor.activeContextScheme}
                activeContextPath={mountedEditor.activeContextPath}
                localDocumentId={mountedEditor.activeLocalDocumentId}
                addressOwnsDocumentAdmission={props.addressOwnsDocumentAdmission}
                active={editorActive}
                sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
                dockToggle={surfaceToggle("chat", t`Expand chat`)}
                onSelectContextPath={props.onSelectContextPath}
                onOpenContextTarget={props.onOpenContextTarget}
                onShowEditorRecents={(options) =>
                  void props.routeCommands.showEditorRecents(options)
                }
              />
            </DraftReviewBoundary>
          ) : null}
        </ProjectRouteBoundary>
      ),
    },
    {
      id: "chat",
      children: (
        <ProjectRouteBoundary destinationKey={props.routeLocationKey}>
          <div
            className="flex min-h-0 flex-1 flex-col"
            role={chatIndexShowing ? undefined : chatPlacement === "center" ? "main" : undefined}
          >
            {/* Stable keys pin chat-surface identity so toggling this header
              controller never risks reconciling the live conversation subtree. */}
            {chatPlacement === "center" && !chatIndexShowing ? (
              <ChatPaneController
                key="chat-pane-controller"
                projectId={props.projectId}
                threadId={chatSurfaceThread}
                sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
                contextToggle={surfaceToggle("context-rail", t`Expand context`)}
              />
            ) : null}
            {/* This keyed surface remains the same mounted element when its slot
              moves between center and dock; placement changes only its chrome.
              Behind the index it keeps the current chat live, and with no
              current chat there is nothing to keep. */}
            {chatIndexShowing && chatSurfaceThread === null ? null : (
              <div
                className="min-h-0 flex-1 flex-col"
                style={{ display: chatIndexShowing ? "none" : "flex" }}
                inert={chatIndexShowing}
                aria-hidden={chatIndexShowing}
              >
                <DraftReviewBoundary value={props.chatReview}>
                  <ChatSurface
                    key="chat-surface"
                    projectId={props.projectId}
                    threadId={chatSurfaceThread}
                    activeWork={props.chatWork}
                    availableWorks={props.availableWorks}
                    activeScreen={screen}
                    placement={chatPlacement}
                    // Mounted-but-hidden when the dock is collapsed, so the live
                    // conversation survives a close/reopen.
                    visible={!chatIndexShowing && (chatPlacement === "center" || isOpen("chat"))}
                    onCloseDock={close("chat")}
                    onOpenContextTarget={props.onOpenContextTarget}
                  />
                </DraftReviewBoundary>
              </div>
            )}
            {chatIndexShowing ? (
              <ChatIndexController
                projectId={props.projectId}
                sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
                contextToggle={surfaceToggle("context-rail", t`Expand context`)}
              />
            ) : null}
          </div>
        </ProjectRouteBoundary>
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
        <ProjectRouteBoundary
          issue={props.routeIssues?.main}
          destinationKey={props.routeLocationKey}
        >
          {renderDesktopPane(props, surfaceToggle)}
        </ProjectRouteBoundary>
      </ProjectShell>
    </TreeCreationProvider>
  );
}

type SurfaceToggleFactory = (surfaceId: SurfaceId, label: string) => PaneHeaderRailToggle;

function renderDesktopPane(props: ResolvedProjectViewProps, surfaceToggle: SurfaceToggleFactory) {
  switch (props.activeScreen) {
    case "chat":
      return null;
    case "work":
      return (
        <WorkPaneController
          projectId={props.projectId}
          routeWork={props.routeWork}
          routeCommands={props.routeCommands}
          sidebarToggle={surfaceToggle("threads", t`Expand sidebar`)}
          chatToggle={surfaceToggle("chat", t`Expand chat`)}
        />
      );
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
