/**
 * MobileProject — phone-class project shell with one active view at a time.
 *
 * This is a sibling of the desktop ProjectShell, not a conditional branch
 * inside it. It reuses the same route-owned ProjectViewProps and inner content
 * components while replacing the desktop grid/rails with top bar + drawer +
 * stacked single-pane navigation. Context drill-in (scheme → folders → file)
 * is entirely route-driven, so the OS/browser back gesture pops levels;
 * up-navigation in the chrome is the top bar's breadcrumb (ancestor taps),
 * not a back button — the drawer trigger stays on every screen.
 */

import { t } from "@lingui/core/macro";
import { MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { type ContextTab, useContextTabs } from "@/client/stores";
import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { DraftReviewBoundary } from "@/features/chat/DraftReviewProvider";
import { ChatSurface } from "../chat/ChatSurface";
import { ChatIndex } from "../chat-index/ChatIndex";
import type { ContextCreateKind } from "../context/context-create-kind";
import { schemeLabel } from "../context/context-schemes";
import type { TreeCreationRequest } from "../context/TreeCreationProvider";
import { useDockViewStore } from "../dock/dock-view-store";
import { EditorReviewIntentClaimant } from "../dock/editor-review-handoff";
import { EditorWorkRecovery } from "../EditorWorkRecovery";
import type { ReviewScopedProjectProps } from "../ProjectView";
import {
  chatSurfaceThreadId,
  displayedChatThreadId,
  useChatNavigation,
  useDockReveal,
} from "../routing/chat-navigation";
import { ProjectRouteBoundary } from "../routing/ProjectRouteBoundary";
import { WorkScreen } from "../work/WorkScreen";
import { ChatBreadcrumb } from "./ChatBreadcrumb";
import { folderAncestry, pathLeafName } from "./context-location";
import { MobileBreadcrumb, type MobileBreadcrumbSegment } from "./MobileBreadcrumb";
import { MobileChatHost } from "./MobileChatHost";
import { MobileChatSheetHeader } from "./MobileChatSheetHeader";
import { MobileContextBrowser } from "./MobileContextBrowser";
import { MobileCreateEntryMenu } from "./MobileCreateEntryMenu";
import { MobileDocumentHost } from "./MobileDocumentHost";
import { MobileKeyboardAware } from "./MobileKeyboardAware";
import { MobileResultsView } from "./MobileResultsView";
import { MobileTopBar } from "./MobileTopBar";
import { NavigationDrawer } from "./NavigationDrawer";

type MobileProjectProps = ReviewScopedProjectProps;

export function MobileProject(props: MobileProjectProps) {
  const { recoveringFirstSend } = useChatNavigation();
  const setDockView = useDockViewStore((state) => state.setDockView);
  // The sheet is the phone's dock: it opens over Work or Editor only. On the
  // Chat screen the chat is already the page. A first send recovering after a
  // reload opens it at mount.
  const [chatOpen, setChatOpen] = useState(
    () => props.activeScreen !== "chat" && recoveringFirstSend,
  );
  const openChatSheet = () => {
    setDockView(props.activeScreen, "chat");
    setChatOpen(true);
  };
  useDockReveal(openChatSheet);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { tabs } = useContextTabs(props.projectId);
  const selectedLocal = tabs.find((tab) => tab.documentId === props.activeLocalDocumentId);
  const localTab =
    selectedLocal?.kind === "new" || selectedLocal?.kind === "tracked" ? selectedLocal : undefined;
  // Pending inline create row (file/folder) in the Files browser. Lifted here
  // because the `+` entry point lives in the top bar's trailing slot while the
  // editable row renders inside MobileContextBrowser's folder listing. The
  // The request is immutable command identity. A route Work change must not
  // retarget a row the writer already opened.
  const [creating, setCreating] = useState<TreeCreationRequest | null>(null);
  // Any navigation (screen switch, drill in/out, opening a file, Results)
  // abandons an uncommitted create row — the row is location-scoped chrome.
  const contextLocation = `${props.activeScreen}|${props.activeContextScheme ?? ""}|${props.activeContextFolder ?? ""}|${props.activeContextPath ?? ""}|${props.resultsOpen}`;
  useEffect(() => setCreating(null), [contextLocation]);
  const crumbs = contextBreadcrumbSegments(props);

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col bg-background text-foreground"
      data-phone-shell="true"
    >
      <MobileTopBar
        activeScreen={props.activeScreen}
        projectTitle={props.projectTitle}
        title={props.resultsOpen ? t`Results` : undefined}
        onOpenDrawer={() => setDrawerOpen(true)}
        breadcrumb={
          props.resultsOpen ? undefined : props.activeScreen === "chat" ? (
            <ChatBreadcrumb projectId={props.projectId} display={props.chatDisplay} />
          ) : crumbs.length > 0 ? (
            <MobileBreadcrumb segments={crumbs} />
          ) : undefined
        }
        chatAction={
          props.activeScreen !== "chat" ? (
            <PhoneIconButton aria-label={t`Open chat`} onClick={openChatSheet}>
              <MessageSquare className="size-5" aria-hidden />
            </PhoneIconButton>
          ) : undefined
        }
        actions={
          props.contextLive
            ? trailingAction(props, (kind) => {
                if (!props.activeContextScheme) return;
                setCreating({
                  scheme: props.activeContextScheme,
                  kind,
                  parentPath: props.activeContextFolder ?? "",
                  workId: props.editorWorkId,
                });
              })
            : undefined
        }
      />
      <main className="main-pane flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectRouteBoundary
          destinationKey={props.routeLocationKey}
          retainWhileLoading={props.retainEditorWhileLoading}
          issue={
            props.routeIssues?.main ??
            (props.activeScreen === "context" && props.editorScope.status === "ready"
              ? props.routeIssues?.editor
              : undefined)
          }
        >
          {renderActiveView(props, creating, () => setCreating(null), localTab)}
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
          <DraftReviewBoundary value={props.chatReview}>
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
          </DraftReviewBoundary>
        </SheetContent>
      </Sheet>
      <NavigationDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        projectId={props.projectId}
        projectTitle={props.projectTitle}
        titleEdit={props.titleEdit}
        activeScreen={props.activeScreen}
        editorWorkId={props.editorWorkId}
        contextLive={props.contextLive}
        activeContextScheme={props.activeContextScheme}
        activeContextPath={props.activeContextPath}
        onSelectScreen={props.onSelectScreen}
        onSelectContextPath={props.onSelectContextPath}
      />
    </div>
  );
}

/**
 * Top-bar trailing action dispatcher — one slot, screen-dependent identity.
 * Chat is where results get produced, so it carries the Results entry;
 * Results carries the visible way back (edge-swipe works too, but a
 * discoverable affordance shouldn't require knowing the gesture). The Files
 * browser inside a scheme (scheme root or a folder, no file open) carries
 * the `+` create menu — creation lands "where you are", the route's current
 * scheme+folder. The Files root (scheme list) gets no `+`: schemes are
 * sources, not folders, so there is no "here" to create into. All other
 * screens leave the slot empty.
 */
function trailingAction(
  props: ReviewScopedProjectProps,
  onRequestCreate: (kind: ContextCreateKind) => void,
) {
  if (props.resultsOpen) {
    return (
      <PhoneIconButton onClick={props.onCloseResults} aria-label={t`Back to chat`}>
        <MessageSquare className="size-5" aria-hidden />
      </PhoneIconButton>
    );
  }
  if (props.activeScreen === "chat" && props.chatDisplay.kind !== "index") {
    return (
      <PhoneIconButton onClick={props.onOpenResults} aria-label={t`Open results`}>
        <Sparkles className="size-5" aria-hidden />
      </PhoneIconButton>
    );
  }
  // All schemes accept creation when browsing a scheme root, matching the desktop tree's per-scheme `+`.
  if (
    props.activeScreen === "context" &&
    props.activeContextScheme &&
    !props.activeContextPath &&
    !props.activeLocalDocumentId
  ) {
    return <MobileCreateEntryMenu onSelect={onRequestCreate} />;
  }
  return undefined;
}

function renderActiveView(
  props: MobileProjectProps,
  creating: TreeCreationRequest | null,
  onCreateDone: () => void,
  localTab?: Extract<ContextTab, { kind: "new" | "tracked" }>,
) {
  if (props.resultsOpen) {
    return <MobileResultsView projectId={props.projectId} />;
  }

  switch (props.activeScreen) {
    case "work":
      return (
        <WorkScreen
          projectId={props.projectId}
          routeWork={props.routeWork}
          routeCommands={props.routeCommands}
        />
      );
    case "chat":
      if (props.chatDisplay.kind === "index")
        return <ChatIndex projectId={props.projectId} namedByChrome />;
      return (
        <DraftReviewBoundary value={props.chatReview}>
          <MobileChatHost
            projectId={props.projectId}
            threadId={displayedChatThreadId(props.chatDisplay)}
            activeWork={props.chatWork}
            availableWorks={props.availableWorks}
            onOpenContextTarget={props.onOpenContextTarget}
          />
        </DraftReviewBoundary>
      );
    case "context":
      if (props.editorScope.status !== "ready") {
        return <EditorWorkRecovery scope={props.editorScope} onRetry={props.retryEditorWork} />;
      }
      if (!props.contextLive) return null;
      return (
        <DraftReviewBoundary value={props.editorReview}>
          <EditorReviewIntentClaimant
            editorWorkId={props.editorWorkId}
            activeScheme={props.activeContextScheme}
            activePath={props.activeContextPath}
          />
          {props.activeContextPath || localTab ? (
            <MobileDocumentHost
              projectId={props.projectId}
              editorWorkId={props.editorWorkId}
              route={props.mobileDocumentRoute}
              localTab={localTab}
            />
          ) : (
            <MobileContextBrowser
              projectId={props.projectId}
              editorWorkId={props.editorWorkId}
              activeContextScheme={props.activeContextScheme}
              activeContextFolder={props.activeContextFolder}
              onSelectContextScheme={props.onSelectContextScheme}
              onSelectContextFolder={props.onSelectContextFolder}
              onSelectContextPath={props.onSelectContextPath}
              creating={
                creating?.scheme === props.activeContextScheme
                  ? {
                      kind: creating.kind,
                      scheme: creating.scheme,
                      parentPath: creating.parentPath,
                      workId: creating.workId,
                    }
                  : null
              }
              onCreateDone={onCreateDone}
            />
          )}
        </DraftReviewBoundary>
      );
  }
}

/**
 * Top-bar breadcrumb for the whole context screen: Files › scheme › folders
 * › file. "Files" is the root crumb and navigates to the scheme list; deeper
 * ancestors navigate to the Files browser at that location (`""` = scheme
 * root). The last segment is the current location and stays non-interactive —
 * at the Files root itself the trail is just a lone "Files". Chat, Work, and
 * routed Results auxiliary state suppresses the trail so the top bar shows its
 * plain centered title instead — Results is not part of the Files hierarchy.
 */
function contextBreadcrumbSegments(props: ReviewScopedProjectProps): MobileBreadcrumbSegment[] {
  if (props.activeScreen !== "context") return [];
  // `t` resolves at render time (this runs per render), matching how
  // schemeLabel localizes — both produce plain strings for the segment.
  const filesLabel = t`Files`;
  if (props.activeLocalDocumentId)
    return [
      { label: filesLabel, onSelect: () => props.onExitContextScheme() },
      { label: t`Untitled` },
    ];
  if (!props.activeContextScheme) {
    // Files root: nothing is drilled in, so "Files" is the current location.
    return [{ label: filesLabel }];
  }
  const segments: MobileBreadcrumbSegment[] = [
    { label: filesLabel, onSelect: () => props.onExitContextScheme() },
    {
      label: schemeLabel(props.activeContextScheme),
      onSelect: () => props.onSelectContextFolder(""),
    },
  ];
  // Route invariant: `folder === dirname(path)` whenever a file is open, so
  // the folder ancestry doubles as the document screen's ancestor trail.
  for (const folder of folderAncestry(props.activeContextFolder)) {
    segments.push({ label: folder.name, onSelect: () => props.onSelectContextFolder(folder.path) });
  }
  if (props.activeContextPath) {
    segments.push({ label: pathLeafName(props.activeContextPath) });
  } else {
    // No file open — the deepest folder (or the scheme itself) is the
    // current location, so strip its navigation affordance.
    const last = segments[segments.length - 1];
    segments[segments.length - 1] = { label: last.label };
  }
  return segments;
}
