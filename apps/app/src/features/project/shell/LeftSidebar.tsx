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
import type { CatalogFile as ContextFile } from "@/client/query/context-catalog-projection";
import { RailScratchSection } from "../chat/ChatScratch";
import { ContextTreePanel } from "../context/ContextTreePanel";
import { serverTabFromFile } from "../context/context-tab-from-file";
import { useOpenProjectDocument } from "../context/open-project-document";
import { useDockDocument } from "../dock/dock-view-store";
import { useDockDocumentTab } from "../dock/use-dock-document-tab";
import { useDockPlacement } from "../dock/use-dock-placement";
import { InlineProjectTitle, type ProjectTitleEdit } from "./InlineProjectTitle";
import { PanelToggleButton } from "./PanelToggleButton";
import type { ScreenKey } from "./screens";
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
export type LeftSidebarProps = {
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
  onSelectContextPath: (path: string, scheme?: ProjectContextTreeScheme) => void;
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
  onSelectContextPath,
  onCollapse,
}: LeftSidebarProps) {
  // A tree click is a known file, so it enters at the dock's commit boundary: beside the
  // chat on the Chat screen (the dock hosts images, PDFs and binaries in its viewer too),
  // and the Editor path everywhere else (see `use-dock-placement`).
  const placement = useDockPlacement();
  const openDocument = useOpenProjectDocument(projectId);
  const handleSelectFile = (scheme: ProjectContextTreeScheme, file: ContextFile) => {
    if (placement.besideChat) {
      const tab = serverTabFromFile(scheme, file, {});
      if (tab) {
        placement.commit(tab);
        return;
      }
    }
    if (!file.editable) {
      onSelectContextPath(file.path, scheme);
      return;
    }
    void openDocument({ documentId: file.documentId, workId: editorWorkId ?? undefined });
  };
  // On the Chat screen the row to highlight is the document open in the dock.
  const dockDocument = useDockDocument(activeScreen, projectId);
  const projectedDock = useDockDocumentTab(projectId, dockDocument);
  const docked = activeScreen === "chat" && !projectedDock.gone ? projectedDock.tab : null;

  return (
    <nav
      aria-label={t`Workspace navigation`}
      className="flex h-full min-h-0 w-full flex-col text-foreground"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <PanelToggleButton
          icon={PanelLeftClose}
          label={t`Collapse sidebar  [`}
          onClick={onCollapse}
        />
        <InlineProjectTitle
          title={projectTitle}
          {...titleEdit}
          className="focus-ring flex h-8 min-w-0 flex-1 cursor-default items-center rounded-md px-2 text-left text-[14px] font-semibold hover:bg-sidebar-accent"
          inputClassName="h-8 px-2 text-[14px] font-semibold"
        />
      </div>

      <WorkspaceNavBody
        activeScreen={activeScreen}
        onSelectScreen={onSelectScreen}
        presentation="desktop"
        scratch={
          <RailScratchSection
            projectId={projectId}
            threadId={chatThreadId}
            editorWorkId={editorWorkId}
            resizable
          />
        }
      >
        {contextLive ? (
          <ContextTreePanel
            projectId={projectId}
            editorWorkId={editorWorkId}
            activeScheme={
              docked ? (docked.kind === "new" ? "unfiled" : docked.scheme) : activeContextScheme
            }
            activePath={docked ? (docked.kind === "new" ? null : docked.path) : activeContextPath}
            onSelectFile={handleSelectFile}
          />
        ) : null}
      </WorkspaceNavBody>
    </nav>
  );
}
