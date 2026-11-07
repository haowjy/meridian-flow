/**
 * LeftSidebar — desktop project navigation combining destinations with the
 * persistent project file tree. Mobile navigation uses a drawer and its
 * context destination uses drill-in browsing.
 *
 * The project-name/collapse header and file-tree body are desktop-specific. The
 * destination and account rows come from `WorkspaceNavBody`, which the phone
 * drawer also composes.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { PanelLeftClose } from "lucide-react";
import { useRef } from "react";
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { RailScratchSection } from "../chat/ChatScratch";
import { ContextTreePanel, UserRailSection } from "../context/ContextTreePanel";
import { useOpenProjectDocument } from "../context/open-project-document";
import { useDockDocument } from "../dock/dock-document-store";
import { useDockDocumentTab } from "../dock/use-dock-document-tab";
import { useProjectTrashNavigation } from "../routing/ProjectNavigationContext";
import { InlineProjectTitle, type ProjectTitleEdit } from "./InlineProjectTitle";
import { PanelToggleButton } from "./PanelToggleButton";
import { ProjectMenu } from "./ProjectMenu";
import type { ScreenKey } from "./screens";
import type { TitleEditHandle } from "./TitleEditSlot";
import { WorkspaceNavBody } from "./WorkspaceNavBody";

/**
 * LeftSidebar — content of the persistent left project slot. The
 * `shelf-surface` slot wrapper in `desktop-layout.ts` paints the rail. One column:
 *
 *   project name (rename), Chat/Work/Editor nav, file tree, Scratch, library/account
 *
 * The collapse control sits at the far-left (same x as the PaneHeader expand
 * control) so toggling the rail never moves the cursor.
 */
type LeftSidebarProps = {
  projectId: string;
  projectTitle: string;
  titleEdit: ProjectTitleEdit;
  activeScreen: ScreenKey;
  editorWorkId: string | null;
  /** The chat on screen, which the Scratch control browses; null hides the control. */
  chatThreadId: string | null;
  contextLive: boolean;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
  /** Collapse the sidebar rail. */
  onCollapse: () => void;
};

export function LeftSidebar({
  projectId,
  projectTitle,
  titleEdit,
  activeScreen,
  editorWorkId,
  chatThreadId,
  contextLive,
  activeContextScheme,
  activeContextPath,
  onSelectScreen,
  onCollapse,
}: LeftSidebarProps) {
  const trashNavigation = useProjectTrashNavigation();
  const titleEditor = useRef<TitleEditHandle>(null);
  const openDocument = useOpenProjectDocument(projectId);
  const handleSelectFile = (
    scheme: ProjectContextTreeScheme,
    file: ContextFile,
    options?: { focus?: true },
  ) => {
    // The tree is navigation: on every screen, a pick goes to the Editor, unlike a chat
    // mention, which peeks in the dock. Identity, not the path: a kept file under a
    // rename is still this row's document.
    void openDocument({
      documentId: file.documentId,
      known: { scheme, file, workId: editorWorkId },
      workId: editorWorkId ?? undefined,
      ...options,
    });
  };
  // On the Chat screen the row to highlight is the document open in the dock.
  const dockDocument = useDockDocument(activeScreen, projectId);
  const projectedDock = useDockDocumentTab(projectId, dockDocument);
  const docked = activeScreen === "chat" && !projectedDock.gone ? projectedDock.tab : null;
  const treePane = useRef<HTMLDivElement>(null);
  const treeActiveScheme = docked
    ? docked.kind === "new"
      ? "unfiled"
      : docked.scheme
    : activeContextScheme;
  const treeActivePath = docked ? (docked.kind === "new" ? null : docked.path) : activeContextPath;

  return (
    <nav
      aria-label={t`Workspace navigation`}
      className="relative flex h-full min-h-0 w-full flex-col text-foreground"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <PanelToggleButton
          icon={PanelLeftClose}
          label={t`Collapse sidebar  [`}
          onClick={onCollapse}
        />
        <InlineProjectTitle
          editRef={titleEditor}
          title={projectTitle}
          {...titleEdit}
          className="focus-ring flex h-8 min-w-0 flex-1 cursor-default items-center rounded-md px-2 text-left text-[14px] font-semibold hover:bg-sidebar-accent"
          inputClassName="h-8 px-2 text-[14px] font-semibold"
        />
        <ProjectMenu
          key={projectId}
          projectId={projectId}
          project={projectTitle}
          onRename={() => titleEditor.current?.start(projectTitle)}
        />
      </div>

      <WorkspaceNavBody
        activeScreen={activeScreen}
        onSelectScreen={onSelectScreen}
        presentation="desktop"
        childrenRef={treePane}
        onOpenTrash={() => void trashNavigation.navigate(true)}
        user={
          contextLive ? (
            <UserRailSection
              projectId={projectId}
              editorWorkId={editorWorkId}
              activeScheme={treeActiveScheme}
              activePath={treeActivePath}
              onSelectFile={handleSelectFile}
              resizeAgainst={treePane}
            />
          ) : null
        }
        scratch={
          <RailScratchSection
            projectId={projectId}
            threadId={chatThreadId}
            editorWorkId={editorWorkId}
            resizeAgainst={treePane}
          />
        }
      >
        {contextLive ? (
          <ContextTreePanel
            projectId={projectId}
            editorWorkId={editorWorkId}
            activeScheme={treeActiveScheme}
            activePath={treeActivePath}
            onSelectFile={handleSelectFile}
          />
        ) : null}
      </WorkspaceNavBody>
    </nav>
  );
}
