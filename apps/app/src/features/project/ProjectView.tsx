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

import { workIdOfDraftOwnerKey } from "@meridian/contracts/branches";
import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import type { ParsedRequestId } from "@meridian/contracts/request-id";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useContextCatalogWake } from "@/client/query/useContextCatalog";
import { fetchCurrentDraftMetadata } from "@/client/query/useDraftMetadata";
import { useProject } from "@/client/query/useProjectList";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useRenameProject } from "@/client/query/useRenameProject";
import { type AddressableWork, useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { observeWorksAvailability } from "@/client/query/works-availability-observer";
import {
  patchAccountRecentsFromTabs,
  readAccountRecents,
  subscribeAccountRecents,
} from "@/client/recents";
import { tabKey, useContextTabsStore, useSelectedDocumentId } from "@/client/stores";
import type { ContextTab } from "@/client/stores/context-tabs-store/context-tabs-store";
import {
  readRecentRoutes,
  retryWorkingSetHydration,
  type WorkingSetHydrationPlan,
} from "@/client/working-set";
import { PaintScope } from "@/components/app/PaintHold";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import { DraftOnlySettlement } from "@/features/draft-review/DraftOnlySettlement";
import {
  DraftReviewBoundary,
  type DraftReviewContextValue,
  PresentedReviewScope,
  useDraftReviewScopeValue,
} from "@/features/draft-review/DraftReviewProvider";
import { chatOwnerKey, workOwnerKey } from "@/features/draft-review/draft-owner-key";
import {
  type DraftReviewStateOwner,
  useDraftReviewStateOwner,
} from "@/features/draft-review/useDraftReviewController";
import {
  useWorkBranchCommands,
  type WorkBranchCommands,
  WorkBranchCommandsBoundary,
} from "@/features/draft-review/useWorkBranchCommands";
import { ImportProvider } from "@/features/import/ImportProvider";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import { ChatIndexController } from "./ChatIndexController";
import { ChatPaneController } from "./ChatPaneController";
import { ContextViewerSurfaceController } from "./ContextPaneController";
import { type ChatPlacement, ChatSurface } from "./chat/ChatSurface";
import {
  useAccountId,
  useContextRemovalCoordinator,
  useDraftCommandOwner,
  useProjectContextAvailabilityCoordinator,
} from "./context/account-feature-context";
import type { ContextRemovalRoutePort } from "./context/context-removal-coordinator";
import { DocumentTrashDialog } from "./context/DocumentTrashDialog";
import { DocumentTrashRestoreProvider } from "./context/DocumentTrashRestoreProvider";
import { resolveEditorFrame } from "./context/editor-presentation";
import { RefusalToasts } from "./context/entry-drag/RefusalToasts";
import { ProjectContextRemovalController } from "./context/ProjectContextRemovalController";
import type { AvailabilityWatchRecord } from "./context/project-context-availability-coordinator";
import { useRemovedNoticeLifetime } from "./context/RemovedDocumentNotice";
import { recentAddressFromTab } from "./context/recent-opening";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { DragHint } from "./context/tree-drop/drag-hint";
import { WindowDropGuard } from "./context/tree-drop/WindowDropGuard";
import { useDesktopProjectController } from "./DesktopProjectController";
import { ChatDocumentsBesideProvider } from "./dock/ChatDocumentsBesideProvider";
import { EditorWorkRecovery } from "./EditorWorkRecovery";
import { type EditorWorkScope, resolveEditorWorkScope } from "./editor-work-scope";
import {
  modeOf,
  NO_COLLAPSED_SLOTS,
  type PanelSlotId,
  type SlotGridSurface,
  type SurfaceId,
  useProjectLayout,
  useProjectSurfacePrefsActions,
  useProjectSurfacePrefsStore,
} from "./layout";
import { MobileProject } from "./mobile/MobileProject";
import {
  addressStateOf,
  type MobileDocumentRoute,
  useMobileDocumentRoute,
} from "./mobile/mobile-document-route";
import { useSelectedOpenDocument } from "./open-documents";
import {
  PresentedDocumentContext,
  type ReviewAddressAdmission,
  resolvePresentedDocument,
} from "./presented-document";
import { ReviewAddressOwner, type ReviewAddressPort } from "./ReviewAddressOwner";
import { EditorReviewHandoffProvider, EditorReviewIntentClaimant } from "./review-launch";
import {
  type ChatDisplay,
  chatSurfaceThreadId,
  displayedChatThreadId,
  useChatNavigation,
  useDockReveal,
} from "./routing/chat-navigation";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import {
  ProjectRouteBoundary,
  type ProjectRouteIssue,
  type ProjectRouteMask,
} from "./routing/ProjectRouteBoundary";
import type { ProjectRouteCommands, RouteWorkResolution } from "./routing/project-route";
import { ContextSidebar } from "./shell/ContextSidebar";
import type { ProjectTitleEdit } from "./shell/InlineProjectTitle";
import { LeftSidebar } from "./shell/LeftSidebar";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import { ProjectShell } from "./shell/ProjectShell";
import type { ScreenKey } from "./shell/screens";
import { useContextProjectAuthority } from "./use-context-project-authority";
import { useReviewAddressSync } from "./use-review-address-sync";
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
    ...(isWorkScopedScheme(value.scheme) && value.workId ? { sourceWorkId: value.workId } : {}),
  };
}

export type ProjectViewProps = {
  projectId: string;
  /** Full route-loaded project, used before the account list query is ready. */
  project: Project;
  /** Resolved screen key from the route (defaults to Chat). */
  activeScreen: ScreenKey;
  /** What the Chat screen or the dock currently shows for chat. */
  chatDisplay: ChatDisplay;
  /** Explicit route Work state; loading/error never collapses into absence. */
  routeWork: RouteWorkResolution;
  /** Validated browser-local Work offered as the collection's return destination. */
  rememberedWork: AddressableWork | null;
  editorRouteWork: Exclude<RouteWorkResolution, { status: "new" | "absent" }>;
  activeLocalDocumentId?: string;
  entryHydration: WorkingSetHydrationPlan;
  routeLocationKey?: string;
  routeIssues?: {
    main?: ProjectRouteIssue;
    editor?: ProjectRouteIssue;
    /** Why an unavailable Editor destination is gone, when its document was removed. */
    removed?: ProjectRouteMask["removed"];
  };
  /** Re-read what a failed Editor address was waiting on. */
  onRetryEditorRoute?: () => void;
  onDisplayedSelection?: (selection: { editorWorkId: ParsedRequestId | null }) => void;
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
  /** The lineage a chat's Scratch route names, in place of a Work. */
  activeContextChat: string | null;
  /** Draft identity persisted by an Editor document address. */
  reviewItemKey?: string;
  /** Whose draft the address's item reviews (`addressReviewOwner`). */
  reviewOwner?: string | null;
  /** The document that item names. */
  reviewDocumentId?: string;
  reviewChangeId?: string;
  /** Document the Editor address resolved to; a review follows it through a rename. */
  reviewAddressDocumentId?: string;
  /** The route's verdict on an explicit review selector; the owner acts only when admitted. */
  reviewAddressAdmission?: ReviewAddressAdmission;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectContextScheme: (scheme: ProjectContextTreeScheme) => void;
  onExitContextScheme: () => void;
  onSelectContextFolder: (folder: string) => void;
  /**
   * Selects a context file. When `scheme` is provided, the URL records it.
   */
  onOpenContextTarget: OpenContextRoute;
  onSetEditorReviewItemKey: (itemKey: string | null, changeId?: string) => void;
};

export function ProjectView(props: ProjectViewProps) {
  const queryClient = useQueryClient();
  const cachedProject = useProject(props.projectId, props.project);
  const projectTitle = cachedProject?.title ?? props.project.title;
  const renameProject = useRenameProject(cachedProject ?? props.project);
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
  // The removed-documents notice sits in Write's tab strip and in Chat's dock header.
  const selectedDocumentId = useSelectedDocumentId(props.projectId);
  useRemovedNoticeLifetime(props.projectId, "editor", {
    key: JSON.stringify([
      props.activeScreen,
      props.activeContextScheme,
      props.activeContextFolder,
      props.activeContextPath,
      props.activeLocalDocumentId,
      props.activeScreen === "chat" ? selectedDocumentId : null,
    ]),
    onScreen: props.activeScreen === "context" || props.activeScreen === "chat",
    showing:
      props.activeScreen === "chat"
        ? selectedDocumentId
        : { scheme: props.activeContextScheme, path: props.activeContextPath },
  });
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
  // A retry answers the entry plan it retried; new route data brings a new one.
  const [retriedHydration, setRetriedHydration] = useState<{
    entry: WorkingSetHydrationPlan;
    plan: WorkingSetHydrationPlan;
  } | null>(null);
  const workingSetHydration =
    retriedHydration?.entry === props.entryHydration ? retriedHydration.plan : props.entryHydration;
  const { threads: projectThreads } = useProjectThreads(props.projectId);
  const worksQuery = useWorks(props.projectId);
  const { works, noWork } = worksQuery;
  // The index shows nothing chat-scoped: the rail and the draft review scope
  // both go to null there, even though the current chat stays warm behind it.
  const displayedChatThread = displayedChatThreadId(props.chatDisplay);
  const chatThread = projectThreads?.find((thread) => thread.id === displayedChatThread);
  const chatWork = chatThread?.workId
    ? workFromSnapshot(noWork ? { works: works ?? [], noWork } : null, chatThread.workId)
    : null;
  const chatWorkId = chatWork?.id ?? null;
  const chatOwner = chatOwnerKey(chatWork, chatThread?.rootThreadId ?? null);
  const editorRouteWork = props.editorRouteWork;
  const editorScope = resolveEditorWorkScope(editorRouteWork);
  const editorWorkId = editorScope.status === "ready" ? editorScope.workId : null;
  const editorWork = editorRouteWork.status === "present" ? editorRouteWork.work : null;
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
    const entry = props.entryHydration;
    const retry = () => {
      void retryWorkingSetHydration(props.projectId).then((plan) =>
        setRetriedHydration({ entry, plan }),
      );
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [props.projectId, props.entryHydration, workingSetHydration.status]);

  // Gate the whole project on prefs-store hydration so DesktopProject mounts
  // exactly once against final persisted prefs. rehydrate() is synchronous
  // (localStorage), so this is at most one frame — no visible flash. Gating here
  // (not inside DesktopProject) avoids a conditional-hook ordering violation.
  const prefsHydrated = useProjectSurfacePrefsStore((s) => s._hydrated);
  const hydrated = prefsHydrated && workspaceHydrated;
  const onSelectEditorContextPath = useCallback(
    (path: string, scheme?: ProjectContextTreeScheme, options?: { replace?: boolean }) => {
      if (editorScope.status !== "ready" || !scheme) return;
      void props.onOpenContextTarget({ path, scheme, workId: editorScope.workId }, options);
    },
    [editorWorkId, editorScope.status, props.onOpenContextTarget],
  );
  const resolvedProps = {
    ...props,
    onSelectContextPath: onSelectEditorContextPath,
    chatWork,
    chatOwner,
    chatWorkId,
    // The review scope's thread: the displayed chat, null on the index.
    chatThreadId: displayedChatThread,
    availableWorks: works ?? [],
    editorScope,
    editorWorkId,
    editorWork,
    retryEditorWork: worksQuery.refetch,
    contextLive: contextPhase.status === "live" && editorScope.status === "ready",
  };
  return (
    <DocumentTrashRestoreProvider key={props.projectId} projectId={props.projectId}>
      <RefusalToasts projectId={props.projectId} />
      <div className="flex h-full min-h-0 w-full bg-background text-foreground">
        <DocumentTrashDialog projectId={props.projectId} />
        {hydrated ? (
          <>
            {resolvedProps.contextLive && editorScope.status === "ready" ? (
              <ProjectContextRemovalController
                projectId={props.projectId}
                activeScreen={props.activeScreen}
                activeContextScheme={props.activeContextScheme}
                activeContextPath={props.activeContextPath}
                activeContextChat={props.activeContextChat}
                editorWorkId={editorScope.workId}
                localDocumentId={props.activeLocalDocumentId}
                reviewDocumentId={props.reviewDocumentId}
                route={props.contextRemovalRoute}
              />
            ) : null}
            <ImportProvider key={props.projectId} projectId={props.projectId}>
              <WindowDropGuard />
              <HydratedReviewProject
                {...resolvedProps}
                projectTitle={projectTitle}
                titleEdit={{ projectId: props.projectId, onSave: renameProject }}
              />
            </ImportProvider>
          </>
        ) : null}
      </div>
    </DocumentTrashRestoreProvider>
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
  chatOwner: string;
  chatWorkId: string | null;
  /** The draft review scope's thread: the displayed chat, null on the index. */
  chatThreadId: string | null;
  availableWorks: readonly Work[];
  editorScope: EditorWorkScope;
  editorWorkId: string | null;
  /** The Editor's Work, when the route names one the project has. */
  editorWork: Work | null;
  retryEditorWork: () => void;
  contextLive: boolean;
};

type ProjectIdentityProps = { projectTitle: string; titleEdit: ProjectTitleEdit };

export type ReviewScopedProjectProps = ResolvedProjectViewProps &
  ProjectIdentityProps & {
    chatCommands: WorkBranchCommands;
    presentedReview: DraftReviewContextValue;
    mobileDocumentRoute: MobileDocumentRoute;
    retainEditorWhileLoading?: boolean;
  };

type MobileEditorPresentation = Pick<
  ResolvedProjectViewProps,
  | "activeContextScheme"
  | "activeContextPath"
  | "activeContextChat"
  | "activeContextFolder"
  | "activeLocalDocumentId"
> & { mobileDocumentRoute: MobileDocumentRoute };

function HydratedReviewProject(props: ResolvedProjectViewProps & ProjectIdentityProps) {
  const { openChat } = useChatNavigation();
  return (
    <ChatThreadNavigationProvider onOpenThread={openChat}>
      {/* Above the review handoff: a review launched beside the chat opens in the dock. */}
      <ChatDocumentsBesideProvider>
        <EditorReviewHandoffProvider
          projectId={props.projectId}
          openContextRoute={props.onOpenContextTarget}
        >
          <HydratedReviewScopes {...props} />
          {/* Every row drop in the view (rail, Work Files) labels the pointer here. */}
          <DragHint />
        </EditorReviewHandoffProvider>
      </ChatDocumentsBesideProvider>
    </ChatThreadNavigationProvider>
  );
}

function HydratedReviewScopes(props: ResolvedProjectViewProps & ProjectIdentityProps) {
  const presentedReviewState = useDraftReviewStateOwner();
  const usePhone = usePhoneShell();
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
    rootThreadId: props.activeContextChat,
    addressState: addressStateOf(props.routeIssues?.editor),
  });
  const priorMobile = useRef<{
    projectId: string;
    workId: string | null;
    presentation: MobileEditorPresentation;
  } | null>(null);
  const retainEditorWhileLoading =
    usePhone === true &&
    props.activeScreen === "context" &&
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
          activeContextChat: props.activeContextChat,
          activeContextFolder: props.activeContextFolder,
          activeLocalDocumentId: props.activeLocalDocumentId,
          mobileDocumentRoute: requestedMobileDocumentRoute,
        },
      };
    } else if (!retainEditorWhileLoading) {
      priorMobile.current = null;
    }
  });
  if (usePhone === null) return null;
  return (
    <HydratedReviewControllers
      {...displayedProps}
      retainEditorWhileLoading={retainEditorWhileLoading}
      presentedReviewState={presentedReviewState}
      mobileDocumentRoute={mobileDocumentRoute}
      usePhone={usePhone}
    />
  );
}

function HydratedReviewControllers({
  presentedReviewState,
  usePhone,
  mobileDocumentRoute,
  ...props
}: ResolvedProjectViewProps & {
  projectTitle: string;
  titleEdit: ProjectTitleEdit;
  presentedReviewState: DraftReviewStateOwner;
  usePhone: boolean;
  mobileDocumentRoute: MobileDocumentRoute;
  retainEditorWhileLoading?: boolean;
}) {
  const chatCommands = useWorkBranchCommands({
    projectId: props.projectId,
    work: props.chatWork,
    ownerKey: props.chatOwner,
    threadId: props.chatThreadId,
  });
  const selected = useSelectedOpenDocument(props.projectId);
  const presented = resolvePresentedDocument({
    phone: usePhone,
    screen: props.activeScreen,
    selected,
  });
  const { works, noWork } = useWorks(props.projectId);
  const reviewOwner =
    presented?.review?.ownerKey ??
    workOwnerKey(props.editorWorkId ? { id: props.editorWorkId } : null);
  // A lineage's drafts carry no Work: its review reads the Editor's own Work for archive state.
  const reviewWorkId = workIdOfDraftOwnerKey(reviewOwner) ?? props.editorWorkId;
  const reviewWork =
    reviewWorkId === props.editorWork?.id
      ? props.editorWork
      : reviewWorkId === noWork?.id
        ? noWork
        : (works?.find((work) => work.id === reviewWorkId) ?? null);
  const selectedKey = selected ? tabKey(selected.tab) : null;
  const showChanges = selected?.view.showChanges ?? true;
  const marks = useMemo(
    () => ({
      visible: showChanges,
      set: (visible: boolean) => {
        if (selectedKey)
          useContextTabsStore
            .getState()
            .setTabState(props.projectId, selectedKey, { view: { showChanges: visible } });
      },
    }),
    [props.projectId, selectedKey, showChanges],
  );
  const presentedReview = useDraftReviewScopeValue({
    projectId: props.projectId,
    work: reviewWork,
    ownerKey: reviewOwner,
    stateOwner: presentedReviewState,
    threadId: null,
    marks,
  });
  // An explicit review address is the scope's: a scope switch drops every pin, and each tab
  // re-resolves from its view.
  const scopeWorkId = props.editorWorkId;
  const priorScope = useRef(scopeWorkId);
  useEffect(() => {
    if (priorScope.current === scopeWorkId) return;
    if (priorScope.current !== null)
      useContextTabsStore.getState().clearReviewPins(props.projectId);
    priorScope.current = scopeWorkId;
  }, [props.projectId, scopeWorkId]);
  const draftCommands = useDraftCommandOwner();
  const queryClient = useQueryClient();
  const addressedItemKey = presented?.review?.itemKey ?? "";
  const generation = () => draftCommands.generation(addressedItemKey);
  const hidden = () => draftCommands.state(addressedItemKey).hidden;
  // A new generation of the addressed item is a new port: the owner retries what it refused.
  // So is the end of a command that hid it: a refused Discard leaves the draft pending.
  const addressedGeneration = useSyncExternalStore(draftCommands.subscribe, generation, generation);
  const addressedHidden = useSyncExternalStore(draftCommands.subscribe, hidden, hidden);
  const port = useMemo<ReviewAddressPort>(() => {
    return {
      write: (review) => {
        if (selectedKey)
          useContextTabsStore.getState().setTabState(props.projectId, selectedKey, {
            reviewPin: review,
            view: { version: "draft" },
          });
      },
      // A hidden draft (a Discard in flight) or a closed one (Discard, here or on another
      // device) has already ended its review: the room owner exits it. A draft-only tab keeps
      // naming it until settlement closes the tab, and admitting it again would re-open what
      // the room owner just closed, every render. The tab names an item, not a draft: the
      // server decides whether a newer draft replaced the closed one.
      admit: async (target) => {
        if (draftCommands.state(target.itemKey).hidden) return false;
        if (draftCommands.state(target.itemKey).closed) {
          const ref = {
            projectId: props.projectId,
            ownerKey: target.ownerKey,
            documentId: target.documentId,
            itemKey: target.itemKey,
          };
          const current = await draftCommands.reconcileClosed(ref, () =>
            fetchCurrentDraftMetadata(queryClient, ref),
          );
          if (!current) return false;
        }
        presentedReview.controller.enterInlineReview(target.documentId, target.itemKey);
        return true;
      },
    };
  }, [
    props.projectId,
    selectedKey,
    presentedReview.controller.enterInlineReview,
    draftCommands,
    queryClient,
    addressedGeneration,
    addressedHidden,
  ]);
  useReviewAddressSync({
    projectId: props.projectId,
    selected,
    writing: props.activeScreen === "context" && !usePhone,
    locationKey: props.routeLocationKey,
    reviewOwner: props.reviewOwner ?? null,
    address: {
      itemKey: props.reviewItemKey,
      changeId: props.reviewChangeId,
      documentId: props.reviewAddressDocumentId,
      admission: props.reviewAddressAdmission,
    },
    writeItemKey: props.onSetEditorReviewItemKey,
  });
  const scopedProps = { ...props, chatCommands, presentedReview, mobileDocumentRoute };
  return (
    <PresentedDocumentContext.Provider value={presented}>
      <PresentedReviewScope value={presentedReview}>
        <DraftOnlySettlement projectId={props.projectId} />
        <ReviewAddressOwner
          review={presentedReview}
          presented={presented}
          admission={
            // An address naming a review is admitted by the route's answer; every other review is
            // the tab's own.
            presented?.container === "editor" &&
            props.reviewItemKey &&
            presented.review?.itemKey === props.reviewItemKey
              ? (props.reviewAddressAdmission ?? "pending")
              : "admitted"
          }
          port={port}
        />
        {usePhone ? <MobileProject {...scopedProps} /> : <DesktopProject {...scopedProps} />}
      </PresentedReviewScope>
    </PresentedDocumentContext.Provider>
  );
}

/** Desktop layout for every destination. */
export function DesktopProject(props: ReviewScopedProjectProps) {
  const screenSwitch = useDesktopProjectController({
    projectId: props.projectId,
    current:
      props.editorScope.status === "ready"
        ? {
            activeContextScheme: props.activeContextScheme,
            activeContextPath: props.activeContextPath,
            activeContextChat: props.activeContextChat,
            activeLocalDocumentId: props.activeLocalDocumentId,
            editorWorkId: props.editorScope.workId,
            localDocumentId: props.activeLocalDocumentId,
          }
        : null,
    requestedWorkId: props.editorWorkId,
    screen: props.activeScreen,
    contextLive: props.contextLive,
    issue: props.routeIssues?.editor,
  });
  const { editorPresentation } = screenSwitch;
  const { active: editorActive, mounted: mountedEditor } = editorPresentation;
  // The Editor's navigation frame names where the writer is going; only the document body
  // keeps the previous destination beneath the mask (see `resolveEditorFrame`).
  const frameEditorRoute = resolveEditorFrame({
    screen: props.activeScreen,
    requested: {
      editorWorkId: props.editorWorkId,
      activeContextScheme: props.activeContextScheme,
      activeContextPath: props.activeContextPath,
      activeContextChat: props.activeContextChat,
      localDocumentId: props.activeLocalDocumentId,
    },
    mounted: mountedEditor
      ? {
          editorWorkId: mountedEditor.editorWorkId,
          activeContextScheme: mountedEditor.activeContextScheme,
          activeContextPath: mountedEditor.activeContextPath,
          activeContextChat: mountedEditor.activeContextChat,
          localDocumentId: mountedEditor.activeLocalDocumentId,
        }
      : null,
  });
  const editorMask: ProjectRouteMask = {
    destinationKey: props.routeLocationKey,
    issue: props.editorScope.status === "ready" ? props.routeIssues?.editor : undefined,
    removed: props.routeIssues?.removed,
    onRetry: props.onRetryEditorRoute,
    retainWhileLoading: editorPresentation.retainWhileLoading,
    recovery:
      props.editorScope.status !== "ready" ? (
        <EditorWorkRecovery scope={props.editorScope} onRetry={props.retryEditorWork} />
      ) : undefined,
  };

  // useProjectLayout subscribes to the slot widths and this mode's panels and
  // returns the merged SurfaceLayoutMap; no other whole-prefs subscription exists.
  const narrowHold = useNarrowWindowHold();
  const layout = useProjectLayout(props.activeScreen, narrowHold.collapsedSlots);
  const mode = modeOf(props.activeScreen);

  const { setSlotOpen, setSlotWidth } = useProjectSurfacePrefsActions();

  useDockReveal(() => setSlotOpen(mode, "dock", true));

  const isOpen = (surfaceId: SurfaceId) => !layout[surfaceId].collapsed;
  // The single writer-driven open/close entry, for this mode's panel. Opening a
  // panel also releases the narrow-window hold on it, so the control can never
  // write a pref that changes nothing on screen.
  const setSlotOpenHere = (slot: PanelSlotId, open: boolean) => {
    if (open) narrowHold.release(slot);
    setSlotOpen(mode, slot, open);
  };
  const setCollapsedFor = (surfaceId: SurfaceId, collapsed: boolean) => {
    const { slot } = layout[surfaceId];
    if (slot === "rail-l" || slot === "dock") setSlotOpenHere(slot, !collapsed);
  };
  const close = (surfaceId: SurfaceId) => () => {
    setCollapsedFor(surfaceId, true);
  };
  const surfaceToggle = (surfaceId: SurfaceId): PaneHeaderRailToggle => ({
    open: isOpen(surfaceId),
  });

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
          chatThreadId={displayedChatThreadId(props.chatDisplay)}
          contextLive={props.contextLive}
          activeContextScheme={props.activeContextScheme}
          activeContextPath={props.activeContextPath}
          onSelectScreen={screenSwitch.selectScreen}
        />
      ),
    },
    {
      id: "context-rail",
      children: (
        <WorkBranchCommandsBoundary value={props.chatCommands}>
          <ContextSidebar
            threadId={displayedChatThreadId(props.chatDisplay)}
            projectId={props.projectId}
            visible={isOpen("context-rail")}
            onClose={close("context-rail")}
          />
        </WorkBranchCommandsBoundary>
      ),
    },
    {
      id: "context-viewer",
      children: frameEditorRoute ? (
        <DraftReviewBoundary value={props.presentedReview}>
          {editorActive && mountedEditor ? (
            <EditorReviewIntentClaimant
              editorWorkId={mountedEditor.editorWorkId}
              activeScheme={props.activeContextScheme}
            />
          ) : null}
          <PaintScope active={props.activeScreen === "context"}>
            <ContextViewerSurfaceController
              projectId={props.projectId}
              {...frameEditorRoute}
              mask={editorMask}
              resolvedEditor={editorPresentation.resolved}
              routeDisplayed={props.activeScreen === "context"}
              active={editorActive}
              sidebarToggle={surfaceToggle("threads")}
              dockToggle={surfaceToggle("chat")}
              onSelectContextPath={props.onSelectContextPath}
              onOpenContextTarget={props.onOpenContextTarget}
              onShowEditorRecents={(options) => void props.routeCommands.showEditorRecents(options)}
            />
          </PaintScope>
        </DraftReviewBoundary>
      ) : null,
    },
    {
      id: "chat",
      children: (
        // Centered, the chat surface owns the main column, so it carries the main issue.
        <ProjectRouteBoundary
          destinationKey={props.routeLocationKey}
          issue={chatPlacement === "center" ? props.routeIssues?.main : undefined}
        >
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
                sidebarToggle={surfaceToggle("threads")}
                contextToggle={surfaceToggle("context-rail")}
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
                <WorkBranchCommandsBoundary value={props.chatCommands}>
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
                </WorkBranchCommandsBoundary>
              </div>
            )}
            {chatIndexShowing ? (
              <ChatIndexController
                projectId={props.projectId}
                sidebarToggle={surfaceToggle("threads")}
                contextToggle={surfaceToggle("context-rail")}
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
        onSetSlotWidth={setSlotWidth}
        onSetSlotOpen={setSlotOpenHere}
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

type SurfaceToggleFactory = (surfaceId: SurfaceId) => PaneHeaderRailToggle;

function renderDesktopPane(props: ResolvedProjectViewProps, surfaceToggle: SurfaceToggleFactory) {
  switch (props.activeScreen) {
    case "chat":
      return null;
    case "work":
      return (
        <WorkPaneController
          projectId={props.projectId}
          routeWork={props.routeWork}
          rememberedWork={props.rememberedWork}
          routeCommands={props.routeCommands}
          sidebarToggle={surfaceToggle("threads")}
          chatToggle={surfaceToggle("chat")}
        />
      );
    case "context":
      // Context owns no destination header — the tab strip absorbs the
      // sidebar/dock expand toggles. See `ContextViewer`.
      return null;
  }
}

/**
 * A window too narrow for a panel holds it closed while it stays narrow, without
 * writing prefs, so the writer's own choice returns when the window widens.
 * Opening the panel by hand releases the hold until the window narrows again.
 */
function useNarrowWindowHold() {
  const [held, setHeld] = useState<readonly PanelSlotId[]>([]);
  useEffect(() => {
    const compact = window.matchMedia(COMPACT_DESKTOP_QUERY);
    const narrow = window.matchMedia(NARROW_DESKTOP_QUERY);
    const apply = () => {
      const next: PanelSlotId[] = [];
      if (compact.matches) next.push("dock");
      if (narrow.matches) next.push("rail-l");
      setHeld(next);
    };
    compact.addEventListener("change", apply);
    narrow.addEventListener("change", apply);
    apply();
    return () => {
      compact.removeEventListener("change", apply);
      narrow.removeEventListener("change", apply);
    };
  }, []);
  const release = useCallback(
    (slot: PanelSlotId) => setHeld((current) => current.filter((held) => held !== slot)),
    [],
  );
  return { collapsedSlots: held.length === 0 ? NO_COLLAPSED_SLOTS : held, release };
}
