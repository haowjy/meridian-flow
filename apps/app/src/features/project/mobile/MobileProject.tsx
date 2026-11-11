/** Renders the mobile project workspace. */

import { t } from "@lingui/core/macro";
import { type LucideIcon, Maximize2, MessageSquare, Pin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ChatFilesMenu } from "@/features/chat/ChatFilesMenu";
import { WorkBranchCommandsBoundary } from "@/features/draft-review/useWorkBranchCommands";
import { ChatSurface } from "../chat/ChatSurface";
import { fileKindIcon } from "../context/context-file-icon";
import { DocumentHost, MainDocumentStatus } from "../context/DocumentHost";
import { RecentDocumentsLanding } from "../context/RecentDocumentsLanding";
import { useRemovedDocumentPhoneNotice } from "../context/RemovedDocumentNotice";
import { useNewDocument } from "../context/use-new-document";
import type { ReviewScopedProjectProps } from "../ProjectView";
import { useChatNavigation } from "../routing/chat-navigation";
import { ProjectRouteBoundary } from "../routing/ProjectRouteBoundary";
import { useOpenInMain } from "../routing/use-open-document-in-editor";
import { sideReasonText, useSideChatName } from "../side/SideHeader";
import { SidePicker } from "../side/SidePicker";
import { useChatOnScreen, useHostChatId, useShellCommands, useSideItem } from "../side/SideView";
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
  // The sheet is the phone's side: never open on arrival, except for a first send recovering
  // after a reload, which needs its chat on screen.
  const [sheetOpen, setSheetOpen] = useState(() => !onChat && chat.recoveringFirstSend);
  // Any open goes to main: the sheet closes rather than cover where the writer went. Arriving is
  // not an open, so a recovering first send keeps its sheet.
  const arrivedAt = useRef(props.routeLocationKey);
  useEffect(() => {
    if (arrivedAt.current === props.routeLocationKey) return;
    arrivedAt.current = props.routeLocationKey;
    setSheetOpen(false);
  }, [props.routeLocationKey]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const main = useMainItem();
  const crumbs = contextBreadcrumbSegments(
    props,
    main.document.local ? main.document.tab?.name : undefined,
  );
  const removedNotice = useRemovedDocumentPhoneNotice(props.projectId);
  // The sheet shows the side's item: a document or a chat, with the desktop's held pick and picker.
  const side = useSideItem();
  const sheetChat = useHostChatId();
  const sideChat = side.item?.kind === "chat" ? side.item : null;
  const sideTab = side.item?.kind === "document" ? side.tab : null;
  const chatName = useSideChatName(props.projectId, sideChat?.chatId ?? sheetChat);
  const sheetName = sideTab?.name ?? (sideChat ? chatName : null);
  const chatOnScreen = useChatOnScreen();
  const mainChatId = props.chatDisplay?.kind === "thread" ? props.chatDisplay.threadId : null;
  const openInMain = useOpenInMain(props.projectId, props.onOpenContextTarget);
  const SheetIcon = sideTab ? fileKindIcon(sideTab.name) : MessageSquare;
  const closeSheet = () => setSheetOpen(false);
  const sheetTitle = sheetName ? (
    <PhoneSideTitle projectId={props.projectId} name={sheetName} icon={SheetIcon} />
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
            // Names what the sheet will show: main's companion, or the held pick.
            <button
              type="button"
              aria-label={t`Show ${sheetName}`}
              onClick={() => setSheetOpen(true)}
              className="focus-ring flex h-11 max-w-36 min-w-11 items-center justify-center gap-1.5 rounded-md px-2 text-muted-foreground"
            >
              <SheetIcon className="size-5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate text-xs">{sheetName}</span>
              {side.source === "held" ? (
                <Pin className="size-3 shrink-0" aria-label={t`Held`} />
              ) : null}
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
          {renderActiveView(props)}
        </ProjectRouteBoundary>
      </main>
      <Sheet open={sheetOpen && sheetName !== null} onOpenChange={setSheetOpen}>
        <SheetContent
          side="right"
          showCloseButton={false}
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
              tab={sideTab}
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
                  onOpenContextTarget={(target) =>
                    void props.onOpenContextTarget(
                      target,
                      sheetChat ? { beside: { chatId: sheetChat } } : undefined,
                    )
                  }
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
        activeContextPath={props.activeContextPath}
        chatThreadId={chatOnScreen}
      />
    </div>
  );
}

function OpenInMainButton({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex shrink-0 items-center">
      <IconButton size="sm" label={t`Open in main`} onClick={onOpen}>
        <Maximize2 className="size-4" aria-hidden />
      </IconButton>
    </div>
  );
}

/** The sheet's name is its picker, with why it is there and the held mark. */
function PhoneSideTitle({
  projectId,
  name,
  icon: Icon,
}: {
  projectId: string;
  name: string;
  icon: LucideIcon;
}) {
  const side = useSideItem();
  const { releaseSide } = useShellCommands(projectId);
  const mainName = useMainItem().document.tab?.name ?? null;
  const reason = side.source === "held" ? null : sideReasonText(side.reason, mainName);
  return (
    <>
      <SidePicker
        projectId={projectId}
        name={name}
        icon={<Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />}
      />
      {reason ? (
        <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{reason}</span>
      ) : null}
      {side.source === "held" ? (
        <IconButton size="sm" label={t`Held here. Follow main again`} onClick={releaseSide}>
          <Pin className="size-4" aria-hidden />
        </IconButton>
      ) : null}
    </>
  );
}

function renderActiveView(props: MobileProjectProps) {
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
  const onNewDocument = useNewDocument(
    props.projectId,
    props.contextLive ? props.onOpenContextTarget : null,
  );
  if (!props.contextLive || props.editorScope.status !== "ready") return null;
  // A masked cold address must not mount a host that repairs it.
  // A warm pending address still owns its retained document presentation.
  if (props.routeIssues?.editor && !props.retainEditorWhileLoading) return null;
  if (!main.document.requested)
    return (
      <RecentDocumentsLanding
        projectId={props.projectId}
        editorWorkId={props.editorWorkId}
        onNewDocument={onNewDocument}
      />
    );
  const tab = main.document.tab;
  if (!tab) return <MainDocumentStatus projectId={props.projectId} main={main.document} />;
  return (
    <DocumentHost
      key={tab.documentId}
      projectId={props.projectId}
      tab={tab}
      place="main"
      visible
      main={main.document}
      presentation="phone"
      editorWorkId={props.editorWorkId}
    />
  );
}

function contextBreadcrumbSegments(
  props: ReviewScopedProjectProps,
  localName?: string,
): MobileBreadcrumbSegment[] {
  if (props.chatDisplay) return [];
  if (props.activeLocalDocumentId) return [{ label: localName ?? t`Untitled` }];
  return props.activeContextPath ? [{ label: pathLeafName(props.activeContextPath) }] : [];
}
