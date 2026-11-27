import { t } from "@lingui/core/macro";
import { FileQuestion, Trash2 } from "lucide-react";
import { DismissableLayer } from "radix-ui/internal";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLiveTabs } from "@/client/project-shell/live-tabs";
import { mainTabKey } from "@/client/project-shell/main-tabs";
import type { OpenDocument } from "@/client/stores";
import { ignoreFieldEscape } from "@/components/ui/field-escape";
import { WorkDraftCommandsBoundary } from "@/features/draft-review/usePressCommands";
import { focusMain } from "@/features/editor/focus-on-open";
import { cn } from "@/lib/utils";
import { ChatPaneController } from "./ChatPaneController";
import { ChatSurface } from "./chat/ChatSurface";
import { RecentChatsLanding } from "./chat/RecentChatsLanding";
import { useShownDocuments } from "./context/account-feature-context";
import { DocumentHost, MainDocumentStatus } from "./context/DocumentHost";
import { RecentDocumentsLanding } from "./context/RecentDocumentsLanding";
import { TrashedDocument } from "./context/TrashedDocument";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { useDocumentStanding } from "./context/use-document-standing";
import { useNewDocument } from "./context/use-new-document";
import {
  NO_HELD_PANELS,
  type PanelSlotId,
  type SlotGridHost,
  useDesktopPanels,
  useProjectSurfacePrefsActions,
} from "./layout";
import { pathLeafName } from "./mobile/context-location";
import type { ReviewScopedProjectProps } from "./ProjectView";
import { useChatNavigation } from "./routing/chat-navigation";
import { useTrashNavigation } from "./routing/ProjectNavigationContext";
import { isProjectRouteMasked, ProjectRouteBoundary } from "./routing/ProjectRouteBoundary";
import { useOnOpen } from "./routing/use-on-open";
import { useOpenInMain } from "./routing/use-open-document-in-editor";
import { LeftSidebar } from "./shell/LeftSidebar";
import { MainHeader } from "./shell/MainHeader";
import { UntabbedChip, useMainTabCommands } from "./shell/MainTabStrip";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import { ProjectShell } from "./shell/ProjectShell";
import { useSidebarTabs } from "./shell/sidebar/sidebar-tabs-store";
import { pageSheetClass } from "./shell/tab-chip";
import { DocumentChoices } from "./side/DocumentChoices";
import { SideChatHeader, SideDocumentHeader, SideEmptyHeader } from "./side/SideHeader";
import {
  useChatOnScreen,
  useHostChatId,
  usePlace,
  useSideItem,
  useSideRevealed,
} from "./side/SideView";
import { useMainItem } from "./views";

/** Below sidebar (264) + side panel (360) + 360 for main, the side panel folds so main keeps its room. */
const COMPACT_DESKTOP_QUERY = "(max-width: 983px)";
const NARROW_DESKTOP_QUERY = "(max-width: 767px)";

export function DesktopProject(props: ReviewScopedProjectProps) {
  const { projectId } = props;
  const narrowHold = useNarrowWindowHold();
  const panels = useDesktopPanels(narrowHold.held);
  const { setSlotOpen, setSlotWidth } = useProjectSurfacePrefsActions();
  const setSlotOpenHere = (slot: PanelSlotId, open: boolean) => {
    if (open) narrowHold.openByHand(slot);
    setSlotOpen(slot, open);
  };
  const sidebarToggle: PaneHeaderRailToggle = { open: panels["rail-l"].open };
  const sideToggle: PaneHeaderRailToggle = { open: panels.side.open };
  const sideOpen = panels.side.open;
  const sidebarOver = narrowHold.narrow && panels["rail-l"].open;
  const { foldSidebar } = narrowHold;
  useOnOpen(() => {
    if (!sidebarOver) return;
    foldSidebar();
    focusMain();
  });
  const asked = useSidebarTabs((state) => state.asked);
  const seenAsk = useRef(asked);
  useEffect(() => {
    if (asked === seenAsk.current) return;
    seenAsk.current = asked;
    if (asked && !panels["rail-l"].open) setSlotOpenHere("rail-l", true);
  });
  const revealed = useSideRevealed();
  const seenReveal = useRef(revealed);
  useEffect(() => {
    if (revealed === seenReveal.current) return;
    seenReveal.current = revealed;
    if (!sideOpen) setSlotOpenHere("side", true);
  });

  const main = useMainItem();
  const chat = useChatNavigation();
  const mainChat = props.chatDisplay;
  const mask = {
    destinationKey: props.routeLocationKey,
    issue: props.routeIssues?.main ?? (mainChat ? undefined : props.routeIssues?.editor),
    unavailable: props.routeIssues?.main ? undefined : props.routeIssues?.unavailable,
    onRetry: props.routeIssues?.main ? undefined : props.onRetryEditorRoute,
    retainWhileLoading: props.retainEditorWhileLoading,
  };
  const masked = isProjectRouteMasked(mask);
  const trashedId = useTrashNavigation().shown;
  const trashed = useDocumentStanding(projectId, trashedId ?? null);
  const trashedName = trashed.kind === "in-trash" ? trashed.node.name : undefined;
  const mainTab = !mainChat && !masked && props.contextLive ? main.document.document : null;

  const shown = useShownDocuments(projectId);
  const side = useSideItem();
  const sideTab = side.item?.kind === "document" ? side.document : null;
  const { tabs } = useLiveTabs().lanes.document;
  const keptTab =
    shown.find(
      (tab) =>
        tab.documentId !== mainTab?.documentId &&
        tab.documentId !== sideTab?.documentId &&
        tabs.some((open) => open.document.documentId === tab.documentId),
    ) ?? null;

  const open = props.onOpenContextTarget;
  const openInMain = useOpenInMain(projectId, open);
  const onNewDocument = useNewDocument(projectId, props.contextLive ? open : null);
  const showDocumentRecents = () => void props.routeCommands.showEditorRecents({ replace: false });
  const mainKey = mainTab ? mainTabKey({ kind: "document", document: mainTab }) : null;
  const tabCommands = useMainTabCommands({ projectId, kind: "document", open, mainKey });

  const documentHost = (tab: OpenDocument, place: "main" | "side" | "kept"): SlotGridHost => ({
    key: `document:${tab.documentId}`,
    slot: place === "main" ? "center" : place === "side" && sideOpen ? "side" : null,
    children: (
      <DocumentHost
        projectId={projectId}
        document={tab}
        place={place}
        visible={place === "main" || (place === "side" && sideOpen)}
        main={place === "main" ? main.document : undefined}
        presentation="desktop"
        editorWorkId={props.editorWorkId}
        header={
          place === "main" ? (
            <MainHeader
              projectId={projectId}
              kind="document"
              open={open}
              mainTab={{ kind: "document", document: tab }}
              onShowRecents={showDocumentRecents}
              onNew={onNewDocument}
              sidebarToggle={sidebarToggle}
              sideToggle={sideToggle}
            />
          ) : place === "side" ? (
            <SideDocumentHeader
              projectId={projectId}
              document={tab}
              onOpenInMain={() => openInMain(tab)}
            />
          ) : null
        }
      />
    ),
  });

  const sideChat = side.item?.kind === "chat" ? side.item : null;
  const chatThread = useHostChatId();
  const chatOnScreen = useChatOnScreen();
  const chatRecents = mainChat?.kind === "chat-recents";
  const chatInMain = mainChat !== null && !chatRecents;
  const chatHost: SlotGridHost = {
    key: "chat",
    slot: chatInMain ? "center" : sideChat && sideOpen ? "side" : null,
    children: (
      <ProjectRouteBoundary
        destinationKey={props.routeLocationKey}
        issue={chatInMain ? props.routeIssues?.main : undefined}
      >
        <WorkDraftCommandsBoundary value={props.chatCommands}>
          <ChatSurface
            projectId={projectId}
            threadId={chatThread}
            about={!chatInMain && sideChat?.chatId === null ? (sideChat.about ?? null) : null}
            activeWork={props.chatWork}
            availableWorks={props.availableWorks}
            place={chatInMain ? "main" : "side"}
            presentation="desktop"
            visible={chatInMain || (sideChat !== null && sideOpen)}
            onOpenContextTarget={(target) => void open(target)}
            header={
              chatInMain ? (
                <ChatPaneController
                  projectId={projectId}
                  threadId={chatThread}
                  open={open}
                  sidebarToggle={sidebarToggle}
                  contextToggle={sideToggle}
                />
              ) : (
                <SideChatHeader
                  projectId={projectId}
                  threadId={chatThread}
                  onOpenInMain={
                    chatThread
                      ? () => void chat.openChat(chatThread)
                      : () => void chat.openNewChat()
                  }
                />
              )
            }
          />
        </WorkDraftCommandsBoundary>
      </ProjectRouteBoundary>
    ),
  };

  // Sorted by key, never by place: React moves a keyed child that falls behind a sibling, and a
  // moved host is re-inserted in the DOM and, under development StrictMode, has its effects
  // replayed with its editor destroyed.
  const documentHosts = [
    ...(mainTab ? [documentHost(mainTab, "main")] : []),
    ...(sideTab && sideTab.documentId !== mainTab?.documentId
      ? [documentHost(sideTab, "side")]
      : []),
    ...(keptTab ? [documentHost(keptTab, "kept")] : []),
  ].sort((a, b) => (a.key < b.key ? -1 : 1));

  const hosts: SlotGridHost[] = [
    {
      key: "sidebar",
      slot: panels["rail-l"].open ? "rail-l" : null,
      children: (
        <SidebarOver over={sidebarOver} onFold={foldSidebar}>
          <LeftSidebar
            projectId={projectId}
            projectTitle={props.projectTitle}
            titleEdit={props.titleEdit}
            editorWorkId={props.editorWorkId}
            chatThreadId={chatOnScreen}
            contextLive={props.contextLive}
            activeDocument={mainTab}
          />
        </SidebarOver>
      ),
    },
    ...documentHosts,
    chatHost,
  ];
  if (chatRecents || (!mainChat && !mainTab))
    hosts.push({
      key: "main",
      slot: "center",
      children: (
        <main className="flex min-h-0 flex-1 flex-col">
          {chatRecents ? (
            <MainHeader
              projectId={projectId}
              kind="chat"
              open={open}
              landing
              onShowRecents={() => void chat.openChatRecents()}
              onNew={() => void chat.openNewChat()}
              sidebarToggle={sidebarToggle}
              sideToggle={sideToggle}
            />
          ) : (
            <MainHeader
              projectId={projectId}
              kind="document"
              open={open}
              landing={!main.document.requested && !trashedId}
              current={
                trashedId ? (
                  <UntabbedChip
                    icon={Trash2}
                    name={trashedName ?? t`Trash`}
                    onClose={tabCommands.closeMain}
                  />
                ) : main.document.requested && mask.issue && mask.issue !== "loading" ? (
                  <UntabbedChip
                    icon={FileQuestion}
                    name={main.document.path ? pathLeafName(main.document.path) : t`Unavailable`}
                    onClose={tabCommands.closeMain}
                  />
                ) : undefined
              }
              onShowRecents={showDocumentRecents}
              onNew={onNewDocument}
              sidebarToggle={sidebarToggle}
              sideToggle={sideToggle}
            />
          )}
          <div className="page-sheet relative flex min-h-0 flex-1 flex-col">
            {chatRecents ? (
              <RecentChatsLanding projectId={projectId} />
            ) : (
              <ProjectRouteBoundary {...mask}>
                {!props.contextLive ? null : trashedId ? (
                  <TrashedDocument key={trashedId} projectId={projectId} documentId={trashedId} />
                ) : main.document.requested ? (
                  <MainDocumentStatus main={main.document} />
                ) : (
                  <RecentDocumentsLanding
                    projectId={projectId}
                    editorWorkId={props.editorWorkId}
                    onNewDocument={onNewDocument}
                  />
                )}
              </ProjectRouteBoundary>
            )}
          </div>
        </main>
      ),
    });
  if (sideOpen && !sideChat && !(sideTab && sideTab.documentId !== mainTab?.documentId))
    hosts.push({
      key: "side-empty",
      slot: "side",
      children: <SideEmpty projectId={projectId} />,
    });

  return (
    <TreeCreationProvider expandSidebar={() => setSlotOpenHere("rail-l", true)}>
      <ProjectShell
        panels={panels}
        hosts={hosts}
        onSetSlotWidth={setSlotWidth}
        onSetSlotOpen={setSlotOpenHere}
        sidebarOver={sidebarOver}
      />
    </TreeCreationProvider>
  );
}

function SideEmpty({ projectId }: { projectId: string }) {
  const { pending, failed } = useSideItem();
  const place = usePlace();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SideEmptyHeader projectId={projectId} />
      <div className={cn(pageSheetClass(true), "flex min-h-0 flex-1")}>
        {pending || failed ? null : (
          <div className="flex min-h-0 min-w-0 flex-1 p-1.5">
            <DocumentChoices
              projectId={projectId}
              current={null}
              choose={(documentId) => place({ kind: "document", documentId })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The sidebar lying over main dismisses as the phone's drawer does: Escape (not one a field
 * inside handles itself) returns the focus to the sidebar toggle, and a press on the page beside
 * it, or Tab out onto it, leaves the focus there. Only the page counts: a dialog or menu over it
 * is a layer above the sidebar, and the toggle is its own control. Focus the app moves onto the
 * page in answer to a press in the sidebar (a new chat's composer after Chat) is not the writer
 * leaving. The layer is always mounted, so the sidebar is never remounted (`SlotGrid`); beside
 * main it has no `onDismiss` and does nothing.
 */
function SidebarOver({
  over,
  onFold,
  children,
}: {
  over: boolean;
  onFold: () => void;
  children: ReactNode;
}) {
  const tabbed = useRef(false);
  return (
    <DismissableLayer.Root
      className="contents"
      onKeyDownCapture={(event) => {
        tabbed.current = event.key === "Tab";
      }}
      onPointerDownCapture={() => {
        tabbed.current = false;
      }}
      onFocusOutside={(event) => {
        if (!tabbed.current) event.preventDefault();
      }}
      onDismiss={over ? onFold : undefined}
      onEscapeKeyDown={(event) => {
        if (!over) return;
        ignoreFieldEscape(event);
        if (event.defaultPrevented) return;
        document.querySelector<HTMLElement>('[data-panel-toggle="left"]')?.focus();
      }}
      onInteractOutside={(event) => {
        const target = event.target instanceof Element ? event.target : null;
        const onPage =
          target?.closest("[data-stable-layout-grid]") &&
          !target.closest('[data-panel-toggle="left"]');
        if (!onPage) event.preventDefault();
      }}
    >
      {children}
    </DismissableLayer.Root>
  );
}

function useNarrowWindowHold() {
  const [held, setHeld] = useState<readonly PanelSlotId[]>(NO_HELD_PANELS);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const compact = window.matchMedia(COMPACT_DESKTOP_QUERY);
    const narrow = window.matchMedia(NARROW_DESKTOP_QUERY);
    const apply = () => {
      const next: PanelSlotId[] = [];
      if (compact.matches) next.push("side");
      if (narrow.matches) next.push("rail-l");
      setHeld(next.length === 0 ? NO_HELD_PANELS : next);
      setNarrow(narrow.matches);
    };
    compact.addEventListener("change", apply);
    narrow.addEventListener("change", apply);
    apply();
    return () => {
      compact.removeEventListener("change", apply);
      narrow.removeEventListener("change", apply);
    };
  }, []);
  const openByHand = useCallback((slot: PanelSlotId) => {
    const other: PanelSlotId = slot === "side" ? "rail-l" : "side";
    const onlyOne = window.matchMedia(COMPACT_DESKTOP_QUERY).matches;
    setHeld((current) => {
      const next: PanelSlotId[] = current.filter((held) => held !== slot && held !== other);
      if (onlyOne) next.push(other);
      return next.length === 0 ? NO_HELD_PANELS : next;
    });
  }, []);
  const foldSidebar = useCallback(() => {
    setHeld((current) => (current.includes("rail-l") ? current : [...current, "rail-l"]));
  }, []);
  return { held, narrow, openByHand, foldSidebar };
}
