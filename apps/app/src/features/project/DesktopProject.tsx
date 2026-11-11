/**
 * DesktopProject — the desktop's three fixed slots (sidebar, main, side) and the hosts in them.
 *
 * `ItemHosts` is the one structural idea: a host per mounted item, keyed by that item, placed in
 * main or the side by grid-area. Opening the side's item in main moves its mounted editor or chat
 * instead of remounting it, so undo, caret, scroll and a running stream survive the swap. Besides
 * main's and the side's, one more document stays mounted, kept hidden so its undo survives a
 * return: the newest one shown that is on screen no longer. So at most three documents are
 * mounted (main, side, kept). One document is in at most one host. What the side shows is
 * `side/SideView`'s resolution.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { readDocumentView } from "@/client/project-shell/document-views";
import type { ContextTab } from "@/client/stores";
import { WorkBranchCommandsBoundary } from "@/features/draft-review/useWorkBranchCommands";
import { ChatIndexController } from "./ChatIndexController";
import { ChatPaneController } from "./ChatPaneController";
import { ChatSurface } from "./chat/ChatSurface";
import {
  useAccountId,
  useAccountResourceReplica,
  useShownDocuments,
} from "./context/account-feature-context";
import { DocumentHost, MainDocumentStatus } from "./context/DocumentHost";
import { RecentDocumentsLanding } from "./context/RecentDocumentsLanding";
import { recentOpening } from "./context/recent-opening";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { useRecordOpenedDocument } from "./context/use-record-opened-document";
import {
  NO_HELD_PANELS,
  type PanelSlotId,
  type SlotGridHost,
  useDesktopPanels,
  useProjectSurfacePrefsActions,
} from "./layout";
import type { ReviewScopedProjectProps } from "./ProjectView";
import { useChatNavigation } from "./routing/chat-navigation";
import {
  type OpenContextRoute,
  useCaptureProjectNavigation,
} from "./routing/ProjectNavigationContext";
import { isProjectRouteMasked, ProjectRouteBoundary } from "./routing/ProjectRouteBoundary";
import { openDocumentInEditor } from "./routing/use-open-document-in-editor";
import { LeftSidebar } from "./shell/LeftSidebar";
import { MainHeader } from "./shell/MainHeader";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import { ProjectShell } from "./shell/ProjectShell";
import { ClosedSideButton } from "./side/ClosedSideButton";
import { SideChatHeader, SideDocumentHeader, SideEmptyHeader } from "./side/SideHeader";
import {
  useChatOnScreen,
  useHostChatId,
  useShellCommands,
  useSideItem,
  useSideRevealed,
} from "./side/SideView";
import { useMainItem } from "./views";

/** Minimum width (px) the main content column may shrink to on desktop. */
const MAIN_MIN_WIDTH = 360;
/** Below sidebar (264) + side panel (360) + main's minimum, the side panel folds so main is never crushed. */
const COMPACT_DESKTOP_QUERY = "(max-width: 983px)";
const NARROW_DESKTOP_QUERY = "(max-width: 767px)";

export function DesktopProject(props: ReviewScopedProjectProps) {
  const { projectId } = props;
  const narrowHold = useNarrowWindowHold();
  const panels = useDesktopPanels(narrowHold.held);
  const { setSlotOpen, setSlotWidth } = useProjectSurfacePrefsActions();
  // The single writer-driven open/close entry for a panel. Opening a panel also releases the
  // narrow-window hold on it, so the control can never write a pref that changes nothing.
  const { releaseSide } = useShellCommands(projectId);
  const setSlotOpenHere = (slot: PanelSlotId, open: boolean) => {
    if (open) narrowHold.release(slot);
    // Closing the side lets go of a held pick: it reopens following main.
    else if (slot === "dock") releaseSide();
    setSlotOpen(slot, open);
  };
  const sidebarToggle: PaneHeaderRailToggle = { open: panels["rail-l"].open };
  const sideToggle: PaneHeaderRailToggle = { open: panels.dock.open };
  const sideOpen = panels.dock.open;
  // A hold made from a link opens the side, so the click has a visible result.
  const revealed = useSideRevealed();
  const seenReveal = useRef(revealed);
  useEffect(() => {
    if (revealed === seenReveal.current) return;
    seenReveal.current = revealed;
    if (!sideOpen) setSlotOpenHere("dock", true);
  });

  const main = useMainItem();
  const chat = useChatNavigation();
  const mainChat = props.chatDisplay;
  const mask = {
    destinationKey: props.routeLocationKey,
    issue: props.routeIssues?.main ?? (mainChat ? undefined : props.routeIssues?.editor),
    removed: props.routeIssues?.main ? undefined : props.routeIssues?.removed,
    onRetry: props.routeIssues?.main ? undefined : props.onRetryEditorRoute,
    retainWhileLoading: props.retainEditorWhileLoading,
  };
  const masked = isProjectRouteMasked(mask);
  // A masked address paints no document: a removed one shows its removed state in place.
  const mainTab = !mainChat && !masked && props.contextLive ? main.document.tab : null;

  // Each mounted document at its host's current descriptor, newest on screen first.
  const shown = useShownDocuments(projectId);
  const side = useSideItem();
  const sideTab = side.item?.kind === "document" ? side.tab : null;
  useRecordSidePick(projectId, side.source === "held" ? sideTab : null);
  // While the side is closed, main's header names what it would show; pressing it opens the side.
  const closedSide = sideOpen ? null : (
    <ClosedSideButton
      projectId={projectId}
      tab={sideTab}
      onOpen={() => setSlotOpenHere("dock", true)}
    />
  );
  // The newest document shown that is off screen stays mounted, hidden. A document moving
  // between main and the side passes through here while main's address loads, so it never
  // remounts.
  const keptTab =
    shown.find(
      (tab) => tab.documentId !== mainTab?.documentId && tab.documentId !== sideTab?.documentId,
    ) ?? null;

  const open = props.onOpenContextTarget;
  const accountId = useAccountId();
  // The draft the document shows travels with it: its address names that draft.
  const openInMain = (tab: ContextTab) =>
    void openDocumentInEditor(open, tab, {
      review: readDocumentView(accountId, projectId, tab.documentId).pin,
    });
  const onNewDocument = useNewDocument(projectId, props.contextLive ? open : null);

  const documentHost = (tab: ContextTab, place: "main" | "side" | "kept"): SlotGridHost => ({
    key: `document:${tab.documentId}`,
    slot: place === "main" ? "center" : place === "side" && sideOpen ? "dock" : null,
    children: (
      <DocumentHost
        projectId={projectId}
        tab={tab}
        place={place}
        visible={place === "main" || (place === "side" && sideOpen)}
        main={place === "main" ? main.document : undefined}
        presentation="desktop"
        editorWorkId={props.editorWorkId}
        header={
          place === "main" ? (
            <MainHeader
              projectId={projectId}
              document={tab}
              onShowRecents={() => void props.routeCommands.showEditorRecents({ replace: false })}
              onNewDocument={onNewDocument}
              sidebarToggle={sidebarToggle}
              sideToggle={sideToggle}
              closedSide={closedSide}
            />
          ) : place === "side" ? (
            <SideDocumentHeader
              projectId={projectId}
              tab={tab}
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
  const chatIndexShowing = mainChat?.kind === "index";
  const chatInMain = mainChat?.kind === "thread";
  const chatHost: SlotGridHost = {
    key: "chat",
    slot: chatInMain ? "center" : sideChat && sideOpen ? "dock" : null,
    children: (
      <ProjectRouteBoundary
        destinationKey={props.routeLocationKey}
        issue={chatInMain ? props.routeIssues?.main : undefined}
      >
        <WorkBranchCommandsBoundary value={props.chatCommands}>
          <ChatSurface
            projectId={projectId}
            threadId={chatThread}
            about={!chatInMain && sideChat?.chatId === null ? (sideChat.about ?? null) : null}
            activeWork={props.chatWork}
            availableWorks={props.availableWorks}
            place={chatInMain ? "main" : "side"}
            visible={chatInMain || (sideChat !== null && sideOpen)}
            onOpenContextTarget={(target) =>
              void open(target, chatThread ? { beside: { chatId: chatThread } } : undefined)
            }
            header={
              chatInMain ? (
                <ChatPaneController
                  projectId={projectId}
                  threadId={chatThread}
                  sidebarToggle={sidebarToggle}
                  contextToggle={sideToggle}
                  closedSide={closedSide}
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
        </WorkBranchCommandsBoundary>
      </ProjectRouteBoundary>
    ),
  };

  // Sorted by key, never by place: React moves a keyed child that falls behind a sibling, and a
  // moved host is re-inserted in the DOM and, under development StrictMode, has its effects
  // replayed with its editor destroyed (#1351).
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
        <LeftSidebar
          projectId={projectId}
          projectTitle={props.projectTitle}
          titleEdit={props.titleEdit}
          editorWorkId={props.editorWorkId}
          chatThreadId={chatOnScreen}
          contextLive={props.contextLive}
          activeDocument={mainTab ?? (mainChat ? sideTab : null)}
        />
      ),
    },
    ...documentHosts,
    chatHost,
  ];
  if (chatIndexShowing)
    hosts.push({
      key: "chat-index",
      slot: "center",
      children: (
        <ChatIndexController
          projectId={projectId}
          sidebarToggle={sidebarToggle}
          contextToggle={sideToggle}
        />
      ),
    });
  else if (!mainChat && !mainTab)
    hosts.push({
      key: "main",
      slot: "center",
      children: (
        <main className="flex min-h-0 flex-1 flex-col">
          <MainHeader
            projectId={projectId}
            document={null}
            onShowRecents={() => void props.routeCommands.showEditorRecents({ replace: false })}
            onNewDocument={onNewDocument}
            sidebarToggle={sidebarToggle}
            sideToggle={sideToggle}
            closedSide={closedSide}
          />
          <div className="page-sheet relative flex min-h-0 flex-1 flex-col">
            <ProjectRouteBoundary {...mask}>
              {!props.contextLive ? null : main.document.requested ? (
                <MainDocumentStatus projectId={projectId} main={main.document} />
              ) : (
                <RecentDocumentsLanding
                  projectId={projectId}
                  editorWorkId={props.editorWorkId}
                  onNewDocument={onNewDocument}
                  holdsRemovedNotice
                />
              )}
            </ProjectRouteBoundary>
          </div>
        </main>
      ),
    });
  if (sideOpen && !sideChat && !(sideTab && sideTab.documentId !== mainTab?.documentId))
    hosts.push({
      key: "side-empty",
      slot: "dock",
      children: <SideEmpty projectId={projectId} />,
    });

  return (
    <TreeCreationProvider expandSidebar={() => setSlotOpenHere("rail-l", true)}>
      <ProjectShell
        panels={panels}
        hosts={hosts}
        onSetSlotWidth={setSlotWidth}
        onSetSlotOpen={setSlotOpenHere}
        mainMinWidth={MAIN_MIN_WIDTH}
      />
    </TreeCreationProvider>
  );
}

/** The side with nothing to show: what goes with main is still being found, or there is none. */
function SideEmpty({ projectId }: { projectId: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SideEmptyHeader projectId={projectId} />
    </div>
  );
}

/** A document the writer picked beside counts as recently opened, once per pick. */
function useRecordSidePick(projectId: string, picked: ContextTab | null) {
  const record = useRecordOpenedDocument();
  const recorded = useRef<string | null>(null);
  useEffect(() => {
    if (!picked) {
      recorded.current = null;
      return;
    }
    if (recorded.current === picked.documentId) return;
    const opening = recentOpening(projectId, picked, new Date().toISOString(), false);
    if (!opening) return;
    recorded.current = picked.documentId;
    record(opening);
  }, [picked, projectId, record]);
}

/** New document: an Untitled document in Unfiled, opened in main with the caret. */
function useNewDocument(
  projectId: string,
  open: OpenContextRoute | null,
): (() => void) | undefined {
  const captureNavigation = useCaptureProjectNavigation();
  const resources = useAccountResourceReplica();
  const create = useCallback(async () => {
    if (!open) return;
    const isCurrent = captureNavigation?.();
    const reservation = await resources.reserveDocument(projectId);
    if (reservation.content.kind !== "opened") throw new Error("Local document is unavailable");
    try {
      if (isCurrent?.() === false) return;
      const documentId = reservation.content.handle.documentId;
      const result = await open(
        { scheme: "unfiled", path: "", documentId },
        {
          isCurrent,
          focus: true,
          tab: {
            kind: "new",
            documentId,
            name: reservation.name,
            resourceHandle: reservation.key.handle,
          },
        },
      );
      if (result.kind === "failed") throw result.error;
    } finally {
      reservation.content.handle.release();
    }
  }, [projectId, resources, open, captureNavigation]);
  return open ? () => void create().catch((error: unknown) => reportError(error)) : undefined;
}

/**
 * A window too narrow for a panel holds it closed while it stays narrow, without writing prefs,
 * so the writer's own choice returns when the window widens. Opening the panel by hand releases
 * the hold until the window narrows again.
 */
function useNarrowWindowHold() {
  const [held, setHeld] = useState<readonly PanelSlotId[]>(NO_HELD_PANELS);
  useEffect(() => {
    const compact = window.matchMedia(COMPACT_DESKTOP_QUERY);
    const narrow = window.matchMedia(NARROW_DESKTOP_QUERY);
    const apply = () => {
      const next: PanelSlotId[] = [];
      if (compact.matches) next.push("dock");
      if (narrow.matches) next.push("rail-l");
      setHeld(next.length === 0 ? NO_HELD_PANELS : next);
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
    (slot: PanelSlotId) =>
      setHeld((current) => {
        const next = current.filter((held) => held !== slot);
        return next.length === 0 ? NO_HELD_PANELS : next;
      }),
    [],
  );
  return { held, release };
}
