import type { ProjectDto as Project } from "@meridian/contracts/projects";
import type { ProjectContextTreeScheme, Work } from "@meridian/contracts/protocol";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { DraftPin } from "@/client/project-shell/document-views";
import { LiveTabsProvider } from "@/client/project-shell/live-tabs";
import { useProject } from "@/client/query/useProjectList";
import { useProjectThreads } from "@/client/query/useProjectThreads";
import { useProjectWake } from "@/client/query/useProjectWake";
import { useRenameProject } from "@/client/query/useRenameProject";
import { useWorks, workFromSnapshot } from "@/client/query/useWorks";
import { patchAccountRecentsFromDocuments } from "@/client/recents";
import { ChatThreadNavigationProvider } from "@/features/chat/ChatThreadNavigation";
import { useConversationRevealRouting } from "@/features/chat/conversation-reveal";
import { usePressCommands, type WorkDraftCommands } from "@/features/draft-review/usePressCommands";
import { ImportProvider } from "@/features/import/ImportProvider";
import { usePhoneShell } from "@/hooks/use-phone-shell";
import {
  useAccountId,
  useDraftCommandOwner,
  useOptionalPresentedDocuments,
} from "./context/account-feature-context";
import type { ContextRemovalRoutePort } from "./context/context-removal-coordinator";
import { DocumentTrashRestoreProvider } from "./context/DocumentTrashRestoreProvider";
import { ProjectContextRemovalController } from "./context/ProjectContextRemovalController";
import { recentAddressFromTab } from "./context/recent-opening";
import type { AddressedDocument } from "./context/route-document-owner";
import { DragHint } from "./context/tree-drop/drag-hint";
import { WindowDropGuard } from "./context/tree-drop/WindowDropGuard";
import { DesktopProject } from "./DesktopProject";
import { useProjectSurfacePrefsStore } from "./layout";
import { MobileProject } from "./mobile/MobileProject";
import { ReviewLaunchProvider } from "./review-launch";
import type { ChatDisplay } from "./routing/chat-navigation";
import type { MainReviewControls } from "./routing/main-review";
import type { OpenContextRoute } from "./routing/ProjectNavigationContext";
import type { ProjectRouteIssue, ProjectRouteMask } from "./routing/ProjectRouteBoundary";
import type { ReviewTarget } from "./routing/project-address";
import { contextRouteRequest, type ProjectRouteCommands } from "./routing/project-route";
import type { ProjectTitleEdit } from "./shell/InlineProjectTitle";
import { ChatDeleteProvider } from "./shell/sidebar/ChatDeleteProvider";
import {
  SideViewProvider,
  useChatOnScreen,
  useNewChatOnScreen,
  usePlaceChat,
} from "./side/SideView";
import type { MainForSide } from "./side/side-item";
import { TreeVersionProvider } from "./tree-version";
import { useDraftAddressSync } from "./use-draft-address-sync";
import { useMainArrival } from "./use-main-arrival";
import {
  type DraftAddressAdmission,
  type MainReviewAddress,
  MainReviewAddressContext,
} from "./use-review-mode";
import { useWorkScopeState, type WorkScope } from "./use-work-scope";
import { addressStateOf, type MainView, MainViewProvider, useMainDocument } from "./views";
import { ManageWorksDialogHost, ManageWorksProvider } from "./work/ManageWorksDialog";

export type ProjectViewProps = {
  projectId: string;
  project: Project;
  chatDisplay: ChatDisplay | null;
  routeLocationKey?: string;
  routeIssues?: {
    main?: ProjectRouteIssue;
    editor?: ProjectRouteIssue;
    unavailable?: ProjectRouteMask["unavailable"];
  };
  onRetryEditorRoute?: () => void;
  routeCommands: ProjectRouteCommands;
  contextRemovalRoute: Omit<ContextRemovalRoutePort, "goBack">;
  routeDocumentId: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextWork: string | null;
  activeContextPath: string | null;
  activeContextChat: string | null;
  draftItemKey?: string;
  draftOwner?: string | null;
  reviewTarget?: ReviewTarget;
  reviewChangeId?: string;
  reviewControls?: MainReviewControls;
  mainAddressDocumentId?: string;
  addressedDocument?: AddressedDocument;
  draftAddressAdmission?: DraftAddressAdmission;
  onOpenContextTarget: OpenContextRoute;
  onSetEditorDraftItemKey: (review: DraftPin | null) => void;
};

export function ProjectView(props: ProjectViewProps) {
  const cachedProject = useProject(props.projectId, props.project);
  const projectTitle = cachedProject?.title ?? props.project.title;
  const renameProject = useRenameProject(cachedProject ?? props.project);
  const accountId = useAccountId();
  useProjectWake(props.projectId);
  const presented = useOptionalPresentedDocuments();
  useEffect(() => {
    const patchRecents = () => {
      patchAccountRecentsFromDocuments(
        accountId,
        props.projectId,
        (presented?.documents(props.projectId) ?? []).flatMap((tab) => {
          const address = recentAddressFromTab(tab);
          return address ? [{ documentId: tab.documentId, name: tab.name, address }] : [];
        }),
      );
    };
    patchRecents();
    return presented?.subscribe(patchRecents);
  }, [accountId, presented, props.projectId]);
  const worksQuery = useWorks(props.projectId);
  const { works, noWork } = worksQuery;
  const editorScope = useWorkScopeState(props.projectId);
  const editorWorkId = editorScope.workId;
  const editorWork =
    (editorWorkId === noWork?.id ? noWork : works?.find((work) => work.id === editorWorkId)) ??
    null;

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
          <div className="flex h-full min-h-0 w-full bg-background text-foreground">
            {hydrated ? (
              <>
                {resolvedProps.contextLive && editorScope.status === "ready" ? (
                  <ProjectContextRemovalController
                    projectId={props.projectId}
                    editorWorkId={editorScope.workId}
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
  editorWork: Work | null;
  contextLive: boolean;
};

type ProjectIdentityProps = { projectTitle: string; titleEdit: ProjectTitleEdit };

export type ReviewScopedProjectProps = ResolvedProjectViewProps &
  ProjectIdentityProps & {
    chatWork: Work | null;
    chatCommands: WorkDraftCommands;
    retainEditorWhileLoading?: boolean;
  };

function HydratedReviewProject(props: ResolvedProjectViewProps & ProjectIdentityProps) {
  return (
    <ReviewLaunchProvider projectId={props.projectId} openContextRoute={props.onOpenContextTarget}>
      <HydratedReviewScopes {...props} />
      <ManageWorksDialogHost projectId={props.projectId} />
      <DragHint />
    </ReviewLaunchProvider>
  );
}

type MainPresentation = Pick<
  ResolvedProjectViewProps,
  "activeContextScheme" | "activeContextPath" | "activeContextChat"
> & { main: MainView };

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
    boundDocumentId: props.routeDocumentId,
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
  const chatThreadId = useChatOnScreen();
  const newChat = useNewChatOnScreen();
  const openThread = usePlaceChat();
  useConversationRevealRouting(openThread);
  const { threads: projectThreads } = useProjectThreads(props.projectId);
  const { works, noWork } = useWorks(props.projectId);
  const chatThread = projectThreads?.find((thread) => thread.id === chatThreadId);
  const chatWork = chatThread?.workId
    ? workFromSnapshot(noWork ? { works: works ?? [], noWork } : null, chatThread.workId)
    : null;
  const chatDraft = chatWork && chatThread ? chatThread.draftId : "";
  const chatDrafts = useMemo(() => (chatDraft ? [chatDraft] : []), [chatDraft]);
  const chatCommands = usePressCommands({
    projectId: props.projectId,
    work: chatWork,
    drafts: chatDrafts,
    threadId: chatThreadId,
    surface: "strip",
  });
  const { notices } = useDraftCommandOwner();
  useEffect(() => () => notices.endProject(props.projectId), [notices, props.projectId]);
  const main = props.chatDisplay === null ? props.mainAddressDocumentId : undefined;
  useDraftAddressSync({
    projectId: props.projectId,
    chatThreadId,
    locationKey: props.routeLocationKey,
    draftOwner: props.draftOwner ?? null,
    address: {
      itemKey: props.draftItemKey,
      documentId: main,
      admission: props.draftAddressAdmission,
    },
    writeItemKey: props.onSetEditorDraftItemKey,
  });
  const mainAddress = useMemo<MainReviewAddress>(
    () => ({
      documentId: main,
      itemKey: props.draftItemKey,
      admission: props.draftAddressAdmission,
      review: props.reviewTarget,
      changeId: props.reviewChangeId,
      controls: props.reviewControls,
    }),
    [
      main,
      props.draftItemKey,
      props.draftAddressAdmission,
      props.reviewTarget,
      props.reviewChangeId,
      props.reviewControls,
    ],
  );
  const scopedProps = { ...props, chatWork, chatCommands };
  return (
    <ChatThreadNavigationProvider onOpenThread={openThread}>
      <MainReviewAddressContext.Provider value={main ? mainAddress : null}>
        <LiveTabsProvider projectId={props.projectId}>
          <TreeVersionProvider
            projectId={props.projectId}
            chatThreadId={chatThreadId}
            newChat={newChat}
          >
            {usePhone ? <MobileProject {...scopedProps} /> : <DesktopProject {...scopedProps} />}
          </TreeVersionProvider>
        </LiveTabsProvider>
      </MainReviewAddressContext.Provider>
    </ChatThreadNavigationProvider>
  );
}
