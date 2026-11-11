/** Renders the mobile project workspace. */

import { t } from "@lingui/core/macro";
import { MessageSquare } from "lucide-react";
import { useState } from "react";
import { type ContextTab, useContextTabs } from "@/client/stores";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { WorkBranchCommandsBoundary } from "@/features/draft-review/useWorkBranchCommands";
import { ChatSurface } from "../chat/ChatSurface";
import { ChatIndex } from "../chat-index/ChatIndex";
import { RecentDocumentsLanding } from "../context/RecentDocumentsLanding";
import { useRemovedDocumentPhoneNotice } from "../context/RemovedDocumentNotice";
import { useContextRemovalProject } from "../context/use-context-removal-project";
import { useFollowOpenDocumentPlacement } from "../context/use-follow-open-document-placement";
import { DocumentReviewProvider } from "../DocumentReview";
import type { ReviewScopedProjectProps } from "../ProjectView";
import {
  chatSurfaceThreadId,
  displayedChatThreadId,
  useChatNavigation,
  useDockReveal,
} from "../routing/chat-navigation";
import { ProjectRouteBoundary } from "../routing/ProjectRouteBoundary";
import { ChatBreadcrumb } from "./ChatBreadcrumb";
import { pathLeafName } from "./context-location";
import { MobileBreadcrumb, type MobileBreadcrumbSegment } from "./MobileBreadcrumb";
import { MobileChatHost } from "./MobileChatHost";
import { MobileChatSheetHeader } from "./MobileChatSheetHeader";
import { MobileDocumentHost } from "./MobileDocumentHost";
import { MobileKeyboardAware } from "./MobileKeyboardAware";
import { MobileTopBar } from "./MobileTopBar";
import { NavigationDrawer } from "./NavigationDrawer";

type MobileProjectProps = ReviewScopedProjectProps;

export function MobileProject(props: MobileProjectProps) {
  const { recoveringFirstSend } = useChatNavigation();
  // The sheet is the phone's dock: it opens over Work or Editor only. On the
  // Chat screen the chat is already the page. A first send recovering after a
  // reload opens it at mount.
  const [chatOpen, setChatOpen] = useState(
    () => props.activeScreen !== "chat" && recoveringFirstSend,
  );
  const openChatSheet = () => {
    setChatOpen(true);
  };
  useDockReveal(openChatSheet);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { tabs } = useContextTabs(props.projectId);
  const { selection } = useContextRemovalProject(props.projectId);
  useFollowOpenDocumentPlacement({
    projectId: props.projectId,
    editorWorkId: props.editorWorkId,
    activeContextWork: props.activeContextWork,
    selection,
    activeContextScheme: props.activeContextScheme,
    activeContextPath: props.activeContextPath,
    activeContextChat: props.activeContextChat,
    routeDisplayed: props.activeScreen === "context",
    onOpenContextTarget: props.onOpenContextTarget,
  });
  const selectedLocal = tabs.find((tab) => tab.documentId === props.activeLocalDocumentId);
  const localTab =
    selectedLocal?.kind === "new" || selectedLocal?.kind === "tracked" ? selectedLocal : undefined;
  const crumbs = contextBreadcrumbSegments(props, localTab?.name);
  const removedNotice = useRemovedDocumentPhoneNotice(props.projectId);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-phone-shell="true"
    >
      <MobileTopBar
        activeScreen={props.activeScreen}
        projectTitle={props.projectTitle}
        onOpenDrawer={() => setDrawerOpen(true)}
        breadcrumb={
          props.activeScreen === "chat" ? (
            <ChatBreadcrumb projectId={props.projectId} display={props.chatDisplay} />
          ) : crumbs.length > 0 ? (
            <MobileBreadcrumb segments={crumbs} />
          ) : undefined
        }
        notice={props.activeScreen === "context" ? removedNotice : undefined}
        chatAction={
          props.activeScreen !== "chat" ? (
            <IconButton size="sm" label={t`Open chat`} onClick={() => openChatSheet()}>
              <MessageSquare className="size-5" aria-hidden />
            </IconButton>
          ) : undefined
        }
        actions={
          props.activeScreen === "chat" ? (
            <ChatFilesMenu
              projectId={props.projectId}
              threadId={displayedChatThreadId(props.chatDisplay)}
            />
          ) : undefined
        }
      />
      <main className="main-pane flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectRouteBoundary
          destinationKey={props.routeLocationKey}
          retainWhileLoading={props.retainEditorWhileLoading}
          onRetry={props.routeIssues?.main ? undefined : props.onRetryEditorRoute}
          removed={props.routeIssues?.main ? undefined : props.routeIssues?.removed}
          issue={
            props.routeIssues?.main ??
            (props.activeScreen === "context" ? props.routeIssues?.editor : undefined)
          }
        >
          {renderActiveView(props, localTab)}
        </ProjectRouteBoundary>
      </main>
      <Sheet open={chatOpen && props.activeScreen !== "chat"} onOpenChange={setChatOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="w-full max-w-full gap-0 p-0 sm:max-w-full"
        >
          <SheetTitle className="sr-only">{t`Chat`}</SheetTitle>
          <SheetDescription className="sr-only">{t`Chat alongside your current screen`}</SheetDescription>
          <WorkBranchCommandsBoundary value={props.chatCommands}>
            <MobileKeyboardAware>
              <ChatSurface
                projectId={props.projectId}
                threadId={chatSurfaceThreadId(props.chatDisplay)}
                activeWork={props.chatWork}
                availableWorks={props.availableWorks}
                activeScreen={props.activeScreen}
                placement="dock"
                renderHeader={(args) => <MobileChatSheetHeader {...args} />}
                // The sheet mounts the surface only while open: it is always
                // visible, and closing the sheet ends it.
                visible
                onCloseDock={() => setChatOpen(false)}
                onOpenContextTarget={props.onOpenContextTarget}
              />
            </MobileKeyboardAware>
          </WorkBranchCommandsBoundary>
        </SheetContent>
      </Sheet>
      <NavigationDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        projectId={props.projectId}
        projectTitle={props.projectTitle}
        titleEdit={props.titleEdit}
        editorWorkId={props.editorWorkId}
        contextLive={props.contextLive}
        activeContextScheme={props.activeContextScheme}
        activeContextPath={props.activeContextPath}
        chatThreadId={displayedChatThreadId(props.chatDisplay)}
      />
    </div>
  );
}

function renderActiveView(
  props: MobileProjectProps,
  localTab?: Extract<ContextTab, { kind: "new" | "tracked" }>,
) {
  switch (props.activeScreen) {
    case "chat":
      if (props.chatDisplay.kind === "index")
        return <ChatIndex projectId={props.projectId} namedByChrome />;
      return (
        <WorkBranchCommandsBoundary value={props.chatCommands}>
          <MobileChatHost
            projectId={props.projectId}
            threadId={displayedChatThreadId(props.chatDisplay)}
            activeWork={props.chatWork}
            availableWorks={props.availableWorks}
            onOpenContextTarget={props.onOpenContextTarget}
          />
        </WorkBranchCommandsBoundary>
      );
    case "context": {
      if (!props.contextLive || props.editorScope.status !== "ready") return null;
      // A masked cold address must not mount a host that repairs it to Files.
      // A warm pending address still owns its retained document presentation.
      if (props.routeIssues?.editor && !props.retainEditorWhileLoading) return null;
      if (!props.activeContextPath && !localTab)
        return (
          <RecentDocumentsLanding projectId={props.projectId} editorWorkId={props.editorWorkId} />
        );
      // The phone's one document host reviews the document its own route names.
      const document = localTab ?? props.mobileDocumentRoute.tab;
      return (
        <DocumentReviewProvider
          key={document?.documentId ?? ""}
          projectId={props.projectId}
          tab={document}
          showing
        >
          <MobileDocumentHost
            projectId={props.projectId}
            editorWorkId={props.editorScope.workId}
            route={props.mobileDocumentRoute}
            localTab={localTab}
          />
        </DocumentReviewProvider>
      );
    }
  }
}

function contextBreadcrumbSegments(
  props: ReviewScopedProjectProps,
  localName?: string,
): MobileBreadcrumbSegment[] {
  if (props.activeScreen !== "context") return [];
  if (props.activeLocalDocumentId) return [{ label: localName ?? t`Untitled` }];
  return props.activeContextPath ? [{ label: pathLeafName(props.activeContextPath) }] : [];
}
