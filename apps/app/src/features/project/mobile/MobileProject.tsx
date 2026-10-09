/** Renders the mobile project workspace. */

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
import { schemeAllowsCreation, schemeLabel } from "../context/context-schemes";
import type { TreeCreationRequest } from "../context/TreeCreationProvider";
import { useDockViewStore } from "../dock/dock-view-store";
import { EditorReviewIntentClaimant } from "../dock/editor-review-handoff";
import { EditorWorkRecovery } from "../EditorWorkRecovery";
import type { ReviewScopedProjectProps } from "../ProjectView";
import {
  chatSurfaceThreadId,
  type DockReveal,
  displayedChatThreadId,
  useChatNavigation,
  useDockReveal,
} from "../routing/chat-navigation";
import { ProjectRouteBoundary } from "../routing/ProjectRouteBoundary";
import { useWorkChrome } from "../work/useWorkChrome";
import { useWorkDeletion, type WorkDeletion } from "../work/useWorkDeletion";
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
  const openChatSheet = (view: DockReveal = "chat") => {
    if (view === "chat") setDockView(props.activeScreen, view);
    setChatOpen(true);
  };
  useDockReveal((view) => openChatSheet(view));
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
  // Any navigation (screen switch, drill in/out, opening a file)
  // abandons an uncommitted create row — the row is location-scoped chrome.
  const contextLocation = `${props.activeScreen}|${props.activeContextScheme ?? ""}|${props.activeContextFolder ?? ""}|${props.activeContextPath ?? ""}`;
  useEffect(() => setCreating(null), [contextLocation]);
  const crumbs = contextBreadcrumbSegments(props);
  const workDeletion = useWorkDeletion(props.projectId, props.routeWork, props.routeCommands);
  const work = useWorkChrome(
    props.projectId,
    props.routeWork,
    props.rememberedWork,
    props.routeCommands,
    workDeletion,
    "quiet",
  );
  const onWorkDetail = props.activeScreen === "work" && !work.onCollection && Boolean(work.title);

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
          ) : onWorkDetail ? (
            <MobileBreadcrumb
              segments={[
                { label: t`Work`, onSelect: work.openCollection, keep: true },
                { label: work.name ?? "", current: work.title },
              ]}
            />
          ) : crumbs.length > 0 ? (
            <MobileBreadcrumb segments={crumbs} />
          ) : undefined
        }
        notice={onWorkDetail ? work.notice : undefined}
        chatAction={
          props.activeScreen !== "chat" ? (
            <PhoneIconButton aria-label={t`Open chat`} onClick={() => openChatSheet()}>
              <MessageSquare className="size-5" aria-hidden />
            </PhoneIconButton>
          ) : undefined
        }
        actions={
          onWorkDetail
            ? work.actions
            : props.contextLive
              ? trailingAction(props, (kind) => {
                  if (!props.activeContextScheme) return;
                  setCreating({
                    scheme: props.activeContextScheme,
                    kind,
                    parentPath: props.activeContextFolder ?? "",
                  });
                })
              : undefined
        }
      />
      <main className="main-pane flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectRouteBoundary
          destinationKey={props.routeLocationKey}
          retainWhileLoading={props.retainEditorWhileLoading}
          onRetry={props.routeIssues?.main ? undefined : props.onRetryEditorRoute}
          issue={
            props.routeIssues?.main ??
            (props.activeScreen === "context" && props.editorScope.status === "ready"
              ? props.routeIssues?.editor
              : undefined)
          }
        >
          {renderActiveView(props, workDeletion, creating, () => setCreating(null), localTab)}
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
        chatThreadId={displayedChatThreadId(props.chatDisplay)}
      />
    </div>
  );
}

/** Top-bar trailing action dispatcher — one slot, screen-dependent identity. */
function trailingAction(
  props: ReviewScopedProjectProps,
  onRequestCreate: (kind: ContextCreateKind) => void,
) {
  // Same per-scheme policy as the desktop tree's `+`: Scratch and Uploads offer no creation.
  if (
    props.activeScreen === "context" &&
    props.activeContextScheme &&
    schemeAllowsCreation(props.activeContextScheme) &&
    !props.activeContextPath &&
    !props.activeLocalDocumentId
  ) {
    return <MobileCreateEntryMenu onSelect={onRequestCreate} />;
  }
  return undefined;
}

function renderActiveView(
  props: MobileProjectProps,
  workDeletion: WorkDeletion,
  creating: TreeCreationRequest | null,
  onCreateDone: () => void,
  localTab?: Extract<ContextTab, { kind: "new" | "tracked" }>,
) {
  switch (props.activeScreen) {
    case "work":
      return (
        <WorkScreen
          projectId={props.projectId}
          routeWork={props.routeWork}
          routeCommands={props.routeCommands}
          deletion={workDeletion}
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
            editorWorkId={props.editorScope.workId}
            activeScheme={props.activeContextScheme}
          />
          {props.activeContextPath || localTab ? (
            <MobileDocumentHost
              projectId={props.projectId}
              editorWorkId={props.editorScope.workId}
              route={props.mobileDocumentRoute}
              localTab={localTab}
            />
          ) : (
            <MobileContextBrowser
              projectId={props.projectId}
              editorWorkId={props.editorScope.workId}
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
  // Scratch is browsed from its owner (a chat's Scratch menu, a Work's Files),
  // never from the Editor's Files, so its trail names where a note lives and
  // links nowhere.
  const browsable = props.activeContextScheme !== "scratch";
  const segments: MobileBreadcrumbSegment[] = [
    { label: filesLabel, onSelect: () => props.onExitContextScheme() },
    {
      label: schemeLabel(props.activeContextScheme),
      ...(browsable ? { onSelect: () => props.onSelectContextFolder("") } : {}),
    },
  ];
  // Route invariant: `folder === dirname(path)` whenever a file is open, so
  // the folder ancestry doubles as the document screen's ancestor trail.
  for (const folder of folderAncestry(props.activeContextFolder)) {
    segments.push({
      label: folder.name,
      ...(browsable ? { onSelect: () => props.onSelectContextFolder(folder.path) } : {}),
    });
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
