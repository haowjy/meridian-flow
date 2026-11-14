/**
 * ProjectView — the controlled project workspace shell.
 *
 * The readable project route owns all navigation state. This view resolves what main shows from
 * the address (`useMainDocument`, one resolver for both shells), provides it (`useMainItem`), and
 * chooses the shell: the desktop's three slots (`DesktopProject`) or the phone's one view. Chat
 * commands are not threaded as props: leaves read them from `useChatNavigation()`.
 */

import { isWorkScopedScheme } from "@meridian/contracts/context-uri";
import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type DraftPin, returnDraftsToLive } from "@/client/project-shell/document-views";
import { LiveTabsProvider } from "@/client/project-shell/live-tabs";
import { useContextCatalogWake } from "@/client/query/useContextCatalog";
import { useProject } from "@/client/query/useProjectList";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useRenameProject } from "@/client/query/useRenameProject";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { observeWorksAvailability } from "@/client/query/works-availability-observer";
import {
  patchAccountRecentsFromDocuments,
  readAccountRecents,
  subscribeAccountRecents,
} from "@/client/recents";
import type { OpenDocument } from "@/client/stores";
import {
  readRecentRoutes,
  retryWorkingSetHydration,
  type WorkingSetHydrationPlan,
} from "@/client/working-set";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import { DraftOnlySettlement } from "@/features/draft-review/DraftOnlySettlement";
import { chatOwnerKey } from "@/features/draft-review/draft-owner-key";
import {
  useWorkBranchCommands,
  type WorkBranchCommands,
} from "@/features/draft-review/useWorkBranchCommands";
import { ImportProvider } from "@/features/import/ImportProvider";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import {
  useAccountId,
  useContextRemovalCoordinator,
  useDraftCommandOwner,
  useOptionalDraftOnlyPresentations,
  useOptionalPresentedDocuments,
  useProjectContextAvailabilityCoordinator,
} from "./context/account-feature-context";
import type { ContextRemovalRoutePort } from "./context/context-removal-coordinator";
import { DocumentTrashRestoreProvider } from "./context/DocumentTrashRestoreProvider";
import { RefusalToasts } from "./context/entry-drag/RefusalToasts";
import { ProjectContextRemovalController } from "./context/ProjectContextRemovalController";
import type { AvailabilityWatchRecord } from "./context/project-context-availability-coordinator";
import { useRemovedNoticeLifetime } from "./context/RemovedDocumentNotice";
import { recentAddressFromTab } from "./context/recent-opening";
import type { AddressedDocument } from "./context/route-document-owner";
import { DragHint } from "./context/tree-drop/drag-hint";
import { WindowDropGuard } from "./context/tree-drop/WindowDropGuard";
import { useContextRemovalProject } from "./context/use-context-removal-project";
import { useFollowOpenDocumentPlacement } from "./context/use-follow-open-document-placement";
import { DesktopProject } from "./DesktopProject";
import { type MainReviewAddress, MainReviewAddressContext } from "./DocumentReview";
import { useProjectSurfacePrefsStore } from "./layout";
import { MobileProject } from "./mobile/MobileProject";
import { ReviewLaunchProvider } from "./review-launch";
import type { ChatDisplay } from "./routing/chat-navigation";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import type { ProjectRouteIssue, ProjectRouteMask } from "./routing/ProjectRouteBoundary";
import { contextRouteRequest, type ProjectRouteCommands } from "./routing/project-route";
import type { ProjectTitleEdit } from "./shell/InlineProjectTitle";
import { ChatDeleteProvider } from "./shell/sidebar/ChatDeleteProvider";
import { SideViewProvider, useChatOnScreen, usePlaceChat } from "./side/SideView";
import type { MainForSide } from "./side/side-item";
import { useMainArrival } from "./use-main-arrival";
import { useReviewAddressSync } from "./use-review-address-sync";
import type { ReviewAddressAdmission } from "./use-review-admission";
import { useWorkScopeState, type WorkScope } from "./use-work-scope";
import { addressStateOf, type MainView, MainViewProvider, useMainDocument } from "./views";
import { ManageWorksDialogHost, ManageWorksProvider } from "./work/ManageWorksDialog";

function availabilityWatchRecord(
  value: Pick<Exclude<OpenDocument, { kind: "new" }>, "documentId" | "scheme"> & {
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
  /** The chat main shows; null when main holds no chat. */
  chatDisplay: ChatDisplay | null;
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
  /** Awaitable route-owner commands used by future collection/detail leaves. */
  routeCommands: ProjectRouteCommands;
  /** Browser route adapter for atomic removal repairs. */
  contextRemovalRoute: Omit<ContextRemovalRoutePort, "goBack">;
  /** Main's document scheme, when the address names a document. */
  activeContextScheme: ProjectContextTreeScheme | null;
  /** A Work's Scratch route: its owning Work. Null for every other document. */
  activeContextWork: string | null;
  /** Main's document path, when the address names a document. */
  activeContextPath: string | null;
  /** The lineage a chat's Scratch route names, in place of a Work. */
  activeContextChat: string | null;
  /** Draft identity persisted by an Editor document address. */
  reviewItemKey?: string;
  /** Whose draft the address's item reviews (`addressReviewOwner`). */
  reviewOwner?: string | null;
  /** The owner the address itself names (a Scratch document's or a draft's), if any. */
  reviewAddressOwner?: string;
  /** The document that item names. */
  reviewDocumentId?: string;
  reviewChangeId?: string;
  /** Document the Editor address resolved to; a review follows it through a rename. */
  reviewAddressDocumentId?: string;
  /**
   * The document the answered address names: from its draft row when live lacks it (a page a
   * draft created), else the server's answer.
   */
  addressedDocument?: AddressedDocument;
  /** The route's verdict on an explicit review selector; the owner acts only when admitted. */
  reviewAddressAdmission?: ReviewAddressAdmission;
  /**
   * Selects a context file. When `scheme` is provided, the URL records it.
   */
  onOpenContextTarget: OpenContextRoute;
  onSetEditorReviewItemKey: (review: DraftPin | null) => void;
};

export function ProjectView(props: ProjectViewProps) {
  const queryClient = useQueryClient();
  const cachedProject = useProject(props.projectId, props.project);
  const projectTitle = cachedProject?.title ?? props.project.title;
  const renameProject = useRenameProject(cachedProject ?? props.project);
  const accountId = useAccountId();
  const availability = useProjectContextAvailabilityCoordinator();
  const removal = useContextRemovalCoordinator();
  const draftOnlyDocuments = useOptionalDraftOnlyPresentations();
  const repairColdWork = useCallback(
    (workId: string) => {
      void availability.coldScopeHint(props.projectId, workId);
    },
    [availability, props.projectId],
  );
  useContextCatalogWake(props.projectId, repairColdWork);
  // The removed-documents notice sits in main's band; a navigation in main ends it.
  useRemovedNoticeLifetime(props.projectId, {
    key: JSON.stringify([props.chatDisplay, props.activeContextScheme, props.activeContextPath]),
    onScreen: true,
  });
  const presented = useOptionalPresentedDocuments();
  useEffect(() => {
    const lease = availability.attachProject(props.projectId);
    const reportWatches = () => {
      const shown = presented?.documents(props.projectId) ?? [];
      lease.watch(
        "presented",
        shown
          .filter((tab): tab is Exclude<OpenDocument, { kind: "new" }> => tab.kind !== "new")
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
      patchAccountRecentsFromDocuments(
        accountId,
        props.projectId,
        shown.flatMap((tab) => {
          const address = recentAddressFromTab(
            tab,
            draftOnlyDocuments?.isDraftOnly(props.projectId, tab.documentId) ?? false,
          );
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
    const stopPresented = presented?.subscribe(reportWatches);
    const stopSelection = removal.subscribe(props.projectId, reportWatches);
    const stopRecents = subscribeAccountRecents(reportWatches);
    const stopDraftOnly = draftOnlyDocuments?.subscribe(reportWatches);
    const stopWorksObservation = observeWorksAvailability(queryClient, props.projectId);
    return () => {
      stopPresented?.();
      stopSelection();
      stopRecents();
      stopDraftOnly?.();
      stopWorksObservation();
      lease.release();
    };
  }, [
    accountId,
    availability,
    draftOnlyDocuments,
    presented,
    props.projectId,
    queryClient,
    removal,
  ]);
  // A retry answers the entry plan it retried; new route data brings a new one.
  const [retriedHydration, setRetriedHydration] = useState<{
    entry: WorkingSetHydrationPlan;
    plan: WorkingSetHydrationPlan;
  } | null>(null);
  const workingSetHydration =
    retriedHydration?.entry === props.entryHydration ? retriedHydration.plan : props.entryHydration;
  const worksQuery = useWorks(props.projectId);
  const { works, noWork } = worksQuery;
  const editorScope = useWorkScopeState(props.projectId);
  const editorWorkId = editorScope.workId;
  const editorWork =
    (editorWorkId === noWork?.id ? noWork : works?.find((work) => work.id === editorWorkId)) ??
    null;
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
  const hydrated = useProjectSurfacePrefsStore((s) => s._hydrated);
  const onSelectEditorContextPath = useCallback(
    (path: string, scheme?: ProjectContextTreeScheme, options?: { replace?: boolean }) => {
      if (editorScope.status !== "ready" || !scheme) return;
      void props.onOpenContextTarget(contextRouteRequest({ path, scheme }), options);
    },
    [editorWorkId, editorScope.status, props.onOpenContextTarget],
  );
  const resolvedProps = {
    ...props,
    onSelectContextPath: onSelectEditorContextPath,
    availableWorks: works ?? [],
    editorScope,
    editorWorkId,
    editorWork,
    contextLive: editorScope.status === "ready",
  };
  return (
    <DocumentTrashRestoreProvider key={props.projectId} projectId={props.projectId}>
      <ChatDeleteProvider key={props.projectId} projectId={props.projectId}>
        <ManageWorksProvider>
          <RefusalToasts projectId={props.projectId} />
          <div className="flex h-full min-h-0 w-full bg-background text-foreground">
            {hydrated ? (
              <>
                {resolvedProps.contextLive && editorScope.status === "ready" ? (
                  <ProjectContextRemovalController
                    projectId={props.projectId}
                    activeContextScheme={props.activeContextScheme}
                    activeContextPath={props.activeContextPath}
                    activeContextChat={props.activeContextChat}
                    editorWorkId={editorScope.workId}
                    activeContextWork={props.activeContextWork}
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
        </ManageWorksProvider>
      </ChatDeleteProvider>
    </DocumentTrashRestoreProvider>
  );
}

export type ResolvedProjectViewProps = ProjectViewProps & {
  onSelectContextPath: (
    path: string,
    scheme?: ProjectContextTreeScheme,
    options?: { replace?: boolean },
  ) => void;
  availableWorks: readonly Work[];
  editorScope: WorkScope;
  editorWorkId: string | null;
  /** The Editor's Work, when the route names one the project has. */
  editorWork: Work | null;
  contextLive: boolean;
};

type ProjectIdentityProps = { projectTitle: string; titleEdit: ProjectTitleEdit };

export type ReviewScopedProjectProps = ResolvedProjectViewProps &
  ProjectIdentityProps & {
    /** The chat on screen's Work (main's chat, or the side's beside a document). */
    chatWork: Work | null;
    chatCommands: WorkBranchCommands;
    /** Main keeps its previous document painted while the new address loads. */
    retainEditorWhileLoading?: boolean;
  };

function HydratedReviewProject(props: ResolvedProjectViewProps & ProjectIdentityProps) {
  return (
    <ReviewLaunchProvider projectId={props.projectId} openContextRoute={props.onOpenContextTarget}>
      <HydratedReviewScopes {...props} />
      <ManageWorksDialogHost projectId={props.projectId} />
      {/* Every row drop in the view (rail, Work Files) labels the pointer here. */}
      <DragHint />
    </ReviewLaunchProvider>
  );
}

type MainPresentation = Pick<
  ResolvedProjectViewProps,
  "activeContextScheme" | "activeContextPath" | "activeContextChat"
> & { main: MainView };

/** Resolves main's document from the address, and keeps the last one painted while one loads. */
function HydratedReviewScopes(props: ResolvedProjectViewProps & ProjectIdentityProps) {
  const usePhone = usePhoneShell();
  const onDocument = props.chatDisplay === null;
  const document = useMainDocument({
    enabled: onDocument && props.contextLive,
    projectId: props.projectId,
    scheme: props.activeContextScheme,
    path: props.activeContextPath,
    workId: props.activeContextWork,
    rootThreadId: props.activeContextChat,
    addressed: props.addressedDocument,
    addressState: addressStateOf(props.routeIssues?.editor),
  });
  const requestedMain = useMemo<MainView>(
    () => ({
      item: props.chatDisplay
        ? props.chatDisplay.kind === "thread"
          ? { kind: "chat", chatId: props.chatDisplay.threadId }
          : null
        : document.document
          ? { kind: "document", documentId: document.document.documentId }
          : null,
      document,
    }),
    [props.chatDisplay, document],
  );
  const prior = useRef<{
    projectId: string;
    workId: string | null;
    presentation: MainPresentation;
  } | null>(null);
  const retainEditorWhileLoading =
    onDocument &&
    props.editorScope.status === "ready" &&
    props.routeIssues?.editor === "loading" &&
    prior.current?.projectId === props.projectId &&
    prior.current.workId === props.activeContextWork;
  const retained = retainEditorWhileLoading ? prior.current?.presentation : null;
  const displayedProps = retained ? { ...props, ...retained } : props;
  const main = retained?.main ?? requestedMain;
  useLayoutEffect(() => {
    if (
      onDocument &&
      props.editorScope.status === "ready" &&
      !props.routeIssues?.editor &&
      requestedMain.document.document
    ) {
      prior.current = {
        projectId: props.projectId,
        workId: props.activeContextWork,
        presentation: {
          activeContextScheme: props.activeContextScheme,
          activeContextPath: props.activeContextPath,
          activeContextChat: props.activeContextChat,
          main: requestedMain,
        },
      };
    } else if (!retainEditorWhileLoading) {
      prior.current = null;
    }
  });
  const accountId = useAccountId();
  const arrived =
    onDocument && props.contextLive && !props.routeIssues?.main && !props.routeIssues?.editor
      ? requestedMain.document.document
      : null;
  const mainForSide: MainForSide = props.chatDisplay
    ? props.chatDisplay.kind === "thread"
      ? { kind: "chat", chatId: props.chatDisplay.threadId }
      : props.chatDisplay.kind === "chat-recents"
        ? { kind: "chat-recents" }
        : { kind: "new-chat" }
    : main.item?.kind === "document"
      ? { kind: "document", documentId: main.item.documentId }
      : main.document.requested && (props.routeIssues?.editor === "loading" || !props.contextLive)
        ? { kind: "opening" }
        : { kind: "landing" };
  useMainArrival({
    accountId,
    projectId: props.projectId,
    main: mainForSide,
    document: arrived,
    locationKey: props.routeLocationKey,
  });
  if (usePhone === null) return null;
  return (
    <MainViewProvider value={main}>
      <SideViewProvider projectId={props.projectId} main={mainForSide}>
        <HydratedReviewControllers
          {...displayedProps}
          retainEditorWhileLoading={retainEditorWhileLoading}
          usePhone={usePhone}
        />
      </SideViewProvider>
    </MainViewProvider>
  );
}

function HydratedReviewControllers({
  usePhone,
  ...props
}: ResolvedProjectViewProps & {
  projectTitle: string;
  titleEdit: ProjectTitleEdit;
  usePhone: boolean;
  retainEditorWhileLoading?: boolean;
}) {
  // Under None the draft scope is the chat on screen: beside a document, the side's chat.
  const chatThreadId = useChatOnScreen();
  // Every chat door and reveal opens through the one placement command.
  const openThread = usePlaceChat();
  useConversationRevealRouting(openThread);
  const { threads: projectThreads } = useProjectThreads(props.projectId);
  const { works, noWork } = useWorks(props.projectId);
  const chatThread = projectThreads?.find((thread) => thread.id === chatThreadId);
  const chatWork = chatThread?.workId
    ? workFromSnapshot(noWork ? { works: works ?? [], noWork } : null, chatThread.workId)
    : null;
  const chatCommands = useWorkBranchCommands({
    projectId: props.projectId,
    work: chatWork,
    ownerKey: chatOwnerKey(chatWork, chatThread?.rootThreadId ?? null),
    threadId: chatThreadId,
    surface: "strip",
  });
  const accountId = useAccountId();
  const draftOnly = useOptionalDraftOnlyPresentations();
  // A Discard notice outlives its surface, not the project: leaving ends it and its room lease.
  const { notices } = useDraftCommandOwner();
  useEffect(() => () => notices.endProject(props.projectId), [notices, props.projectId]);
  // A Work pick returns every document showing a draft to Live. A draft-only page has no Live
  // version: it keeps its draft.
  const scopeWorkId = props.editorWorkId;
  const priorScope = useRef(scopeWorkId);
  useEffect(() => {
    if (priorScope.current === scopeWorkId) return;
    if (priorScope.current !== null)
      returnDraftsToLive(
        accountId,
        props.projectId,
        (documentId) => draftOnly?.isDraftOnly(props.projectId, documentId) ?? false,
      );
    priorScope.current = scopeWorkId;
  }, [accountId, draftOnly, props.projectId, scopeWorkId]);
  const main = props.chatDisplay === null ? props.reviewAddressDocumentId : undefined;
  useReviewAddressSync({
    projectId: props.projectId,
    locationKey: props.routeLocationKey,
    reviewOwner: props.reviewOwner ?? null,
    address: {
      owner: props.reviewAddressOwner,
      itemKey: props.reviewItemKey,
      changeId: props.reviewChangeId,
      documentId: main,
      admission: props.reviewAddressAdmission,
    },
    writeItemKey: props.onSetEditorReviewItemKey,
  });
  const mainAddress = useMemo<MainReviewAddress>(
    () => ({
      documentId: main,
      itemKey: props.reviewItemKey,
      admission: props.reviewAddressAdmission,
    }),
    [main, props.reviewItemKey, props.reviewAddressAdmission],
  );
  const { selection } = useContextRemovalProject(props.projectId);
  useFollowOpenDocumentPlacement({
    projectId: props.projectId,
    editorWorkId: props.editorWorkId,
    activeContextWork: props.activeContextWork,
    selection,
    activeContextScheme: props.activeContextScheme,
    activeContextPath: props.activeContextPath,
    activeContextChat: props.activeContextChat,
    onOpenContextTarget: props.onOpenContextTarget,
  });
  const scopedProps = { ...props, chatWork, chatCommands };
  return (
    <ChatThreadNavigationProvider onOpenThread={openThread}>
      <MainReviewAddressContext.Provider value={main ? mainAddress : null}>
        <DraftOnlySettlement projectId={props.projectId} />
        <LiveTabsProvider projectId={props.projectId}>
          {usePhone ? <MobileProject {...scopedProps} /> : <DesktopProject {...scopedProps} />}
        </LiveTabsProvider>
      </MainReviewAddressContext.Provider>
    </ChatThreadNavigationProvider>
  );
}
