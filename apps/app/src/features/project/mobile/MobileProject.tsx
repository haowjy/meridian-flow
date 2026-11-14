/** Renders the mobile project workspace. */

import { t } from "@lingui/core/macro";
import { useBlocker, useRouterState } from "@tanstack/react-router";
import { Maximize2, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isThreadAwaitingCreation } from "@/client/chat-submissions";
import { useTrashedDocument } from "@/client/query/useDocumentTrash";
import { useDismissalFocus } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { WorkBranchCommandsBoundary } from "@/features/draft-review/useWorkBranchCommands";
import { ChatSurface } from "../chat/ChatSurface";
import { RecentChatsLanding } from "../chat/RecentChatsLanding";
import { useAccountId } from "../context/account-feature-context";
import { fileKindIcon } from "../context/context-file-icon";
import { DocumentHost, MainDocumentStatus } from "../context/DocumentHost";
import { RecentDocumentsLanding } from "../context/RecentDocumentsLanding";
import { useRemovedDocumentPhoneNotice } from "../context/RemovedDocumentNotice";
import { TrashedDocument } from "../context/TrashedDocument";
import { useNewDocument } from "../context/use-new-document";
import type { ReviewScopedProjectProps } from "../ProjectView";
import { PanePlaceContext } from "../pane-place";
import { useChatNavigation } from "../routing/chat-navigation";
import { useTrashNavigation } from "../routing/ProjectNavigationContext";
import { ProjectRouteBoundary } from "../routing/ProjectRouteBoundary";
import { useOpenInMain } from "../routing/use-open-document-in-editor";
import { useSideChatName } from "../side/SideHeader";
import { SidePicker } from "../side/SidePicker";
import { useChatOnScreen, useHostChatId, useSideItem, useSideRevealed } from "../side/SideView";
import { useMainItem } from "../views";
import { ChatBreadcrumb } from "./ChatBreadcrumb";
import { pathLeafName } from "./context-location";
import { MobileBreadcrumb, type MobileBreadcrumbSegment } from "./MobileBreadcrumb";
import { MobileChatHost } from "./MobileChatHost";
import { MobileKeyboardAware } from "./MobileKeyboardAware";
import { MobileSideSheetHeader } from "./MobileSideSheetHeader";
import { MobileTopBar } from "./MobileTopBar";
import { NavigationDrawer } from "./NavigationDrawer";

type MobileProjectProps = ReviewScopedProjectProps;

export function MobileProject(props: MobileProjectProps) {
  const chat = useChatNavigation();
  const onChat = props.chatDisplay !== null;
  const accountId = useAccountId();
  // The sheet is the phone's side: never open on arrival, except for a first send still
  // recovering when the phone shell mounts, which needs its chat on screen.
  const [sheetOpen, setSheetOpen] = useState(
    () => !onChat && isThreadAwaitingCreation(accountId, chat.lastShownChatId),
  );
  // Any open goes to main: the sheet closes rather than cover where the writer went. Arriving is
  // not an open, so a recovering first send keeps its sheet. The history position, not the
  // entry's key: an address repair (a rename, a stripped param) replaces the entry in place.
  const position = useRouterState({ select: (state) => state.location.state.__TSR_index });
  const arrivedAt = useRef(position);
  useEffect(() => {
    if (arrivedAt.current === position) return;
    arrivedAt.current = position;
    setSheetOpen(false);
  }, [position]);
  // An item placed in the side (a chat link in a document) shows the sheet, as it opens the side
  // on the desktop.
  const revealed = useSideRevealed();
  const seenReveal = useRef(revealed);
  useEffect(() => {
    if (revealed === seenReveal.current) return;
    seenReveal.current = revealed;
    setSheetOpen(true);
  }, [revealed]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const trashedId = useTrashNavigation().shown;
  const trashedName = useTrashedDocument(props.projectId, trashedId ?? null).data?.name;
  const crumbs = trashedId
    ? [{ label: trashedName ?? t`Trash` }]
    : contextBreadcrumbSegments(props);
  const removedNotice = useRemovedDocumentPhoneNotice(props.projectId);
  // The sheet shows the side's item: a document or a chat, with the desktop's picker.
  const side = useSideItem();
  const sheetChat = useHostChatId();
  const sideChat = side.item?.kind === "chat" ? side.item : null;
  const sideTab = side.item?.kind === "document" ? side.document : null;
  const chatName = useSideChatName(props.projectId, sideChat?.chatId ?? sheetChat);
  const sheetName = sideTab?.name ?? (sideChat ? chatName : null);
  const chatOnScreen = useChatOnScreen();
  const mainChatId = props.chatDisplay?.kind === "thread" ? props.chatDisplay.threadId : null;
  const openInMain = useOpenInMain(props.projectId, props.onOpenContextTarget);
  const SheetIcon = sideTab ? fileKindIcon(sideTab.name) : MessageSquare;
  const sheet = useDismissalFocus(setSheetOpen);
  const closeSheet = () => sheet.onOpenChange(false);
  const sheetVisible = sheetOpen && sheetName !== null;
  // The sheet is no history entry, so Back while it is open dismisses it and leaves main where it is.
  useBlocker({
    shouldBlockFn: ({ action }) => {
      if (action !== "BACK" || !sheetVisible) return false;
      closeSheet();
      return true;
    },
    enableBeforeUnload: false,
  });
  const sheetTitle = sheetName ? (
    <SidePicker
      projectId={props.projectId}
      name={sheetName}
      icon={<SheetIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
    />
  ) : null;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-phone-shell="true"
    >
      <MobileTopBar
        onChat={onChat}
        projectTitle={props.projectTitle}
        onOpenDrawer={() => setDrawerOpen(true)}
        breadcrumb={
          props.chatDisplay ? (
            <ChatBreadcrumb projectId={props.projectId} display={props.chatDisplay} />
          ) : crumbs.length > 0 ? (
            <MobileBreadcrumb segments={crumbs} />
          ) : undefined
        }
        notice={onChat ? undefined : removedNotice}
        chatAction={
          sheetName ? (
            // Names what the sheet will show: the slot of the kind main is not.
            <button
              type="button"
              aria-label={t`Show ${sheetName}`}
              onClick={() => setSheetOpen(true)}
              className="focus-ring flex h-11 max-w-36 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-muted-foreground"
            >
              <SheetIcon className="size-5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate text-xs">{sheetName}</span>
            </button>
          ) : undefined
        }
        actions={
          onChat ? <ChatFilesMenu projectId={props.projectId} threadId={mainChatId} /> : undefined
        }
      />
      <main className="main-pane flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectRouteBoundary
          destinationKey={props.routeLocationKey}
          retainWhileLoading={props.retainEditorWhileLoading}
          onRetry={props.routeIssues?.main ? undefined : props.onRetryEditorRoute}
          removed={props.routeIssues?.main ? undefined : props.routeIssues?.removed}
          issue={props.routeIssues?.main ?? (onChat ? undefined : props.routeIssues?.editor)}
        >
          <PanePlaceContext.Provider value="main">
            {renderActiveView(props)}
          </PanePlaceContext.Provider>
        </ProjectRouteBoundary>
      </main>
      <Sheet open={sheetVisible} onOpenChange={sheet.onOpenChange}>
        <SheetContent
          side="right"
          showCloseButton={false}
          {...sheet.content}
          className="w-full max-w-full gap-0 p-0 sm:max-w-full"
        >
          <SheetTitle className="sr-only">{sheetName ?? t`Beside`}</SheetTitle>
          <SheetDescription className="sr-only">{t`Beside your current screen`}</SheetDescription>
          {sideTab ? (
            // The sheet mounts its host only while open: it is always visible, and closing the
            // sheet ends it.
            <DocumentHost
              key={sideTab.documentId}
              projectId={props.projectId}
              document={sideTab}
              place="side"
              visible
              presentation="phone"
              editorWorkId={props.editorWorkId}
              header={
                <MobileSideSheetHeader
                  title={sheetTitle}
                  actions={<OpenInMainButton onOpen={() => openInMain(sideTab)} />}
                  onClose={closeSheet}
                />
              }
            />
          ) : (
            <WorkBranchCommandsBoundary value={props.chatCommands}>
              <MobileKeyboardAware>
                <ChatSurface
                  projectId={props.projectId}
                  threadId={sheetChat}
                  about={sideChat?.chatId === null ? (sideChat.about ?? null) : null}
                  activeWork={props.chatWork}
                  availableWorks={props.availableWorks}
                  place="side"
                  presentation="phone"
                  header={
                    <MobileSideSheetHeader
                      title={sheetTitle}
                      actions={
                        <>
                          <ChatFilesMenu projectId={props.projectId} threadId={sheetChat} />
                          <OpenInMainButton
                            onOpen={() =>
                              void (sheetChat ? chat.openChat(sheetChat) : chat.openNewChat())
                            }
                          />
                        </>
                      }
                      onClose={closeSheet}
                    />
                  }
                  visible
                  onOpenContextTarget={(target) => void props.onOpenContextTarget(target)}
                />
              </MobileKeyboardAware>
            </WorkBranchCommandsBoundary>
          )}
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
        activeContextWork={props.activeContextWork}
        chatThreadId={chatOnScreen}
      />
    </div>
  );
}

function OpenInMainButton({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton size="sm" label={t`Open in main`} onClick={onOpen}>
        <Maximize2 aria-hidden />
      </IconButton>
    </div>
  );
}

function renderActiveView(props: MobileProjectProps) {
  if (props.chatDisplay?.kind === "chat-recents")
    return <RecentChatsLanding projectId={props.projectId} />;
  if (props.chatDisplay) {
    return (
      <WorkBranchCommandsBoundary value={props.chatCommands}>
        <MobileChatHost
          projectId={props.projectId}
          threadId={props.chatDisplay.kind === "thread" ? props.chatDisplay.threadId : null}
          activeWork={props.chatWork}
          availableWorks={props.availableWorks}
          onOpenContextTarget={props.onOpenContextTarget}
        />
      </WorkBranchCommandsBoundary>
    );
  }
  return <PhoneMain {...props} />;
}

/** The phone's one view on a document address: main's document host, its status, or Recents. */
function PhoneMain(props: MobileProjectProps) {
  const main = useMainItem();
  const trashedId = useTrashNavigation().shown;
  const onNewDocument = useNewDocument(
    props.projectId,
    props.contextLive ? props.onOpenContextTarget : null,
  );
  if (!props.contextLive || props.editorScope.status !== "ready") return null;
  // A masked cold address must not mount a host that repairs it.
  // A warm pending address still owns its retained document presentation.
  if (props.routeIssues?.editor && !props.retainEditorWhileLoading) return null;
  if (trashedId)
    return <TrashedDocument key={trashedId} projectId={props.projectId} documentId={trashedId} />;
  if (!main.document.requested)
    return (
      <RecentDocumentsLanding
        projectId={props.projectId}
        editorWorkId={props.editorWorkId}
        onNewDocument={onNewDocument}
      />
    );
  const tab = main.document.document;
  if (!tab) return <MainDocumentStatus main={main.document} />;
  return (
    <DocumentHost
      key={tab.documentId}
      projectId={props.projectId}
      document={tab}
      place="main"
      visible
      main={main.document}
      presentation="phone"
      editorWorkId={props.editorWorkId}
    />
  );
}

function contextBreadcrumbSegments(props: ReviewScopedProjectProps): MobileBreadcrumbSegment[] {
  if (props.chatDisplay) return [];
  return props.activeContextPath ? [{ label: pathLeafName(props.activeContextPath) }] : [];
}
