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
import { ContextTreePanel } from "../context/ContextTreePanel";
import { useOpenProjectDocument } from "../context/open-project-document";
import { InlineProjectTitle, type ProjectTitleEdit } from "./InlineProjectTitle";
import { PanelToggleButton } from "./PanelToggleButton";
import type { ScreenKey } from "./screens";
import { WorkspaceNavBody } from "./WorkspaceNavBody";

/**
 * LeftSidebar — content of the persistent left project slot. The
 * `shelf-surface` slot wrapper in `desktop-layout.ts` paints the rail. One column:
 *
 *   project name (rename) · Chat/Work/Editor nav · file tree · library/account
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
  contextLive,
  activeContextScheme,
  activeContextPath,
  onSelectScreen,
  onSelectContextPath,
  onCollapse,
}: LeftSidebarProps) {
  const openDocument = useOpenProjectDocument(projectId);
  const handleSelectFile = (scheme: ProjectContextTreeScheme, file: ContextFile) => {
    if (!file.editable) {
      onSelectContextPath(file.path, scheme);
      return;
    }
    void openDocument({ documentId: file.documentId, workId: editorWorkId });
  };

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
      >
        {contextLive ? (
          <ContextTreePanel
            projectId={projectId}
            editorWorkId={editorWorkId}
            activeScheme={activeContextScheme}
            activePath={activeContextPath}
            onSelectFile={handleSelectFile}
          />
        ) : null}
      </WorkspaceNavBody>
    </nav>
  );
}
