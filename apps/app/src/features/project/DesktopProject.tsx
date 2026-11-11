/**
 * DesktopProject — the desktop's three fixed slots (sidebar, main, side) and the hosts in them.
 *
 * `ItemHosts` is the one structural idea: a host per mounted item, keyed by that item, placed in
 * main or the side by grid-area. Opening the side's item in main moves its mounted editor or chat
 * instead of remounting it, so undo, caret, scroll and a running stream survive the swap. Besides
 * main's and the side's, one more document stays mounted, kept hidden so its undo survives a
 * return: the newest one shown that is on screen no longer. Beside a document the side is a
 * chat, so at most two documents are mounted. One document is in at most one host.
 */
import { useCallback, useEffect, useState } from "react";
import { readDocumentView } from "@/client/project-shell/document-views";
import { useRecentDocuments } from "@/client/query/useRecentDocuments";
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
import { useDescribeProjectDocument } from "./context/open-project-document";
import { RecentDocumentsLanding } from "./context/RecentDocumentsLanding";
import { TreeCreationProvider } from "./context/TreeCreationProvider";
import {
  NO_HELD_PANELS,
  type PanelSlotId,
  type SlotGridHost,
  useDesktopPanels,
  useProjectSurfacePrefsActions,
} from "./layout";
import type { ReviewScopedProjectProps } from "./ProjectView";
import { chatSurfaceThreadId, useChatNavigation } from "./routing/chat-navigation";
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
import { SideChatHeader, SideDocumentHeader } from "./side/SideHeader";
import { resolveSideItem, useMainItem } from "./views";

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
    if (open) narrowHold.release(slot);
    setSlotOpen(slot, open);
  };
  const sidebarToggle: PaneHeaderRailToggle = { open: panels["rail-l"].open };
  const sideToggle: PaneHeaderRailToggle = { open: panels.dock.open };
  const sideOpen = panels.dock.open;

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

  const recent = useRecentDocuments(projectId);
  // Each mounted document at its host's current descriptor, newest on screen first.
  const shown = useShownDocuments(projectId);
  // Beside a chat: the last document on screen (a draft-only one included, which recents never
  // list), else the account's most recent.
  const side = resolveSideItem(
    mainChat !== null,
    chat.currentThreadId,
    shown[0]?.documentId ?? recent.documents[0]?.documentId ?? null,
  );
  const sideDocumentId = side.item?.kind === "document" ? side.item.documentId : null;
  const sideTab = useDescribedDocument(projectId, sideDocumentId, shown);
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
            />
          ) : place === "side" ? (
            <SideDocumentHeader tab={tab} onOpenInMain={() => openInMain(tab)} />
          ) : null
        }
      />
    ),
  });

  const sideChat = side.item?.kind === "chat";
  const chatThread = chatSurfaceThreadId(chat);
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
            activeWork={props.chatWork}
            availableWorks={props.availableWorks}
            place={chatInMain ? "main" : "side"}
            visible={chatInMain || (sideChat && sideOpen)}
            onOpenContextTarget={(target) => void open(target)}
            header={
              chatInMain ? (
                <ChatPaneController
                  projectId={projectId}
                  threadId={chatThread}
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
          chatThreadId={chatThread}
          contextLive={props.contextLive}
          activeDocument={mainTab ?? (mainChat ? sideTab : null)}
        />
      ),
    },
    ...(mainTab ? [documentHost(mainTab, "main")] : []),
    ...(sideTab && sideTab.documentId !== mainTab?.documentId
      ? [documentHost(sideTab, "side")]
      : []),
    ...(keptTab ? [documentHost(keptTab, "kept")] : []),
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
    hosts.push({ key: "side-empty", slot: "dock", children: <SideEmpty /> });

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

/** Nothing to show beside a chat yet: no document has been opened in this project. */
function SideEmpty() {
  return <div className="flex min-h-0 flex-1" aria-hidden />;
}

/** A document's descriptor: a mounted host's, else resolved once by its identity. */
function useDescribedDocument(
  projectId: string,
  documentId: string | null,
  known: readonly ContextTab[],
): ContextTab | null {
  const describe = useDescribeProjectDocument(projectId);
  const knownTab = documentId ? known.find((tab) => tab.documentId === documentId) : undefined;
  const [described, setDescribed] = useState<{ documentId: string; tab: ContextTab | null } | null>(
    null,
  );
  const needsLookup = documentId !== null && knownTab === undefined;
  useEffect(() => {
    if (!needsLookup || !documentId) return;
    let live = true;
    void describe(documentId).then(
      (tab) => {
        if (live) setDescribed({ documentId, tab });
      },
      () => {
        if (live) setDescribed({ documentId, tab: null });
      },
    );
    return () => {
      live = false;
    };
  }, [needsLookup, documentId, describe]);
  if (knownTab) return knownTab;
  return described?.documentId === documentId ? described.tab : null;
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
