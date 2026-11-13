/**
 * DesktopProject — the desktop's three fixed slots (sidebar, main, side) and the hosts in them.
 *
 * `ItemHosts` is the one structural idea: a host per mounted item, keyed by that item, placed in
 * main or the side by grid-area. Opening the side's item in main moves its mounted editor or chat
 * instead of remounting it, so undo, caret, scroll and a running stream survive the swap. Besides
 * main's and the side's, one more document stays mounted, kept hidden so its undo survives a
 * return: the newest open tab shown that is on screen no longer. So at most three documents are
 * mounted (main, side, kept). One document is in at most one host. What the side shows is
 * `side/SideView`'s resolution.
 */

import { t } from "@lingui/core/macro";
import { FileQuestion, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLiveTabs } from "@/client/project-shell/live-tabs";
import { mainTabKey } from "@/client/project-shell/main-tabs";
import { useTrashedDocument } from "@/client/query/useDocumentTrash";
import type { OpenDocument } from "@/client/stores";
import { WorkBranchCommandsBoundary } from "@/features/draft-review/useWorkBranchCommands";
import { cn } from "@/lib/utils";
import { ChatPaneController } from "./ChatPaneController";
import { ChatSurface } from "./chat/ChatSurface";
import { useShownDocuments } from "./context/account-feature-context";
import { DocumentHost, MainDocumentStatus } from "./context/DocumentHost";
import { RecentDocumentsLanding } from "./context/RecentDocumentsLanding";
import { TrashedDocument } from "./context/TrashedDocument";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import { useNewDocument } from "./context/use-new-document";
import { useOpenTabSessions } from "./context/use-open-tab-sessions";
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
import { useOpenInMain } from "./routing/use-open-document-in-editor";
import { LeftSidebar } from "./shell/LeftSidebar";
import { MainHeader } from "./shell/MainHeader";
import { UntabbedChip, useMainTabCommands } from "./shell/MainTabStrip";
import type { PaneHeaderRailToggle } from "./shell/PaneHeader";
import { ProjectShell } from "./shell/ProjectShell";
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
  const setSlotOpenHere = (slot: PanelSlotId, open: boolean) => {
    if (open) narrowHold.openByHand(slot);
    setSlotOpen(slot, open);
  };
  const sidebarToggle: PaneHeaderRailToggle = { open: panels["rail-l"].open };
  const sideToggle: PaneHeaderRailToggle = { open: panels.side.open };
  const sideOpen = panels.side.open;
  // A document held beside from a link opens the side, so the click has a visible result.
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
    removed: props.routeIssues?.main ? undefined : props.routeIssues?.removed,
    onRetry: props.routeIssues?.main ? undefined : props.onRetryEditorRoute,
    retainWhileLoading: props.retainEditorWhileLoading,
  };
  const masked = isProjectRouteMasked(mask);
  const trashedId = useTrashNavigation().shown;
  const trashedName = useTrashedDocument(projectId, trashedId ?? null).data?.name;
  // A masked address paints no document: a removed one shows its removed state in place.
  const mainTab = !mainChat && !masked && props.contextLive ? main.document.document : null;

  // Each mounted document at its host's current descriptor, newest on screen first.
  const shown = useShownDocuments(projectId);
  const side = useSideItem();
  const sideTab = side.item?.kind === "document" ? side.document : null;
  // The newest open tab shown that is off screen stays mounted, hidden: closing a tab lets its
  // editor go. A document moving
  // between main and the side passes through here while main's address loads, so it never
  // remounts. A tab the strip leaves out (its document is gone) keeps no host.
  const { tabs } = useLiveTabs().lanes.document;
  useOpenTabSessions(projectId, tabs, shown);
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
  const onShowRecents = props.routeCommands.showEditorRecents;
  const mainKey = mainTab ? mainTabKey({ kind: "document", document: mainTab }) : null;
  const tabCommands = useMainTabCommands({
    projectId,
    kind: "document",
    open,
    mainKey,
    onShowRecents,
  });

  // Each document has its own host, so the draft that takes the focus when its controls show is
  // kept here.
  const [focusReview, setFocusReview] = useState<string | null>(null);
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
        focusReview={focusReview}
        onFocusReview={setFocusReview}
        header={
          place === "main" ? (
            <MainHeader
              projectId={projectId}
              kind="document"
              open={open}
              mainTab={{ kind: "document", document: tab }}
              onShowRecents={onShowRecents}
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
  const chatInMain = mainChat !== null;
  const chatHost: SlotGridHost = {
    key: "chat",
    slot: chatInMain ? "center" : sideChat && sideOpen ? "side" : null,
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
            presentation="desktop"
            visible={chatInMain || (sideChat !== null && sideOpen)}
            onOpenContextTarget={(target) => void open(target)}
            header={
              chatInMain ? (
                <ChatPaneController
                  projectId={projectId}
                  threadId={chatThread}
                  open={open}
                  onShowRecents={onShowRecents}
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
          activeDocument={mainTab}
        />
      ),
    },
    ...documentHosts,
    chatHost,
  ];
  if (!mainChat && !mainTab)
    hosts.push({
      key: "main",
      slot: "center",
      children: (
        <main className="flex min-h-0 flex-1 flex-col">
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
            onShowRecents={onShowRecents}
            onNew={onNewDocument}
            sidebarToggle={sidebarToggle}
            sideToggle={sideToggle}
          />
          <div className="page-sheet relative flex min-h-0 flex-1 flex-col">
            <ProjectRouteBoundary {...mask}>
              {!props.contextLive ? null : trashedId ? (
                <TrashedDocument key={trashedId} projectId={projectId} documentId={trashedId} />
              ) : main.document.requested ? (
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
        mainMinWidth={MAIN_MIN_WIDTH}
      />
    </TreeCreationProvider>
  );
}

/** The side with nothing to show: a document is still being found, or none is open. */
function SideEmpty({ projectId }: { projectId: string }) {
  const { pending, failed } = useSideItem();
  const place = usePlace();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SideEmptyHeader projectId={projectId} />
      <div className={cn(pageSheetClass(true), "flex min-h-0 flex-1")}>
        {pending || failed ? null : (
          // The dropdown's inset, so the list reads the same in both places.
          <div className="flex min-h-0 min-w-0 flex-1 p-1.5">
            <DocumentChoices
              projectId={projectId}
              choose={(documentId) => place({ kind: "document", documentId })}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A window too narrow for a panel holds it closed while it stays narrow, without writing prefs,
 * so the writer's own choice returns when the window widens. Opening a panel by hand releases
 * its hold until the window narrows again; in a window too narrow for both, it holds the other
 * one closed instead, so main keeps its minimum.
 */
function useNarrowWindowHold() {
  const [held, setHeld] = useState<readonly PanelSlotId[]>(NO_HELD_PANELS);
  useEffect(() => {
    const compact = window.matchMedia(COMPACT_DESKTOP_QUERY);
    const narrow = window.matchMedia(NARROW_DESKTOP_QUERY);
    const apply = () => {
      const next: PanelSlotId[] = [];
      if (compact.matches) next.push("side");
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
  const openByHand = useCallback((slot: PanelSlotId) => {
    const other: PanelSlotId = slot === "side" ? "rail-l" : "side";
    const onlyOne = window.matchMedia(COMPACT_DESKTOP_QUERY).matches;
    setHeld((current) => {
      const next: PanelSlotId[] = current.filter((held) => held !== slot && held !== other);
      if (onlyOne) next.push(other);
      return next.length === 0 ? NO_HELD_PANELS : next;
    });
  }, []);
  return { held, openByHand };
}
