/**
 * LeftSidebar — desktop project navigation combining destinations with the
 * persistent project file tree. Mobile navigation uses a drawer and its
 * context destination uses drill-in browsing.
 *
 * The wordmark/collapse header and file-tree body are desktop-specific. The
 * destination, write-mode, and account rows come from `WorkspaceNavBody`,
 * which the phone drawer also composes.
 */
import { t } from "@lingui/core/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Link } from "@tanstack/react-router";
import { PanelLeftClose } from "lucide-react";

import { MeridianMark } from "@/components/app/MeridianMark";
import { ContextTreePanel } from "../context/ContextTreePanel";
import type { ContextCreateKind } from "../context/context-create-kind";
import type { ContextFile } from "../context/context-tree";
import { PanelToggleButton } from "./PanelToggleButton";
import type { ScreenKey } from "./screens";
import { WorkspaceNavBody } from "./WorkspaceNavBody";

/**
 * LeftSidebar — content of the persistent left project slot (the rail owns
 * `bg-sidebar`, the rounded inside edge, and the shadow). One column:
 *
 *   wordmark (links to app home) · Home/Chat/Editor nav · file tree · account
 *
 * The collapse control sits at the far-left (same x as the PaneHeader expand
 * control) so toggling the rail never moves the cursor.
 */
export type LeftSidebarProps = {
  projectId: string;
  activeScreen: ScreenKey;
  activeThreadId: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectContextPath: (path: string, scheme?: ProjectContextTreeScheme) => void;
  /** Collapse the sidebar rail. */
  onCollapse: () => void;
  /** Tree inline-create state — owned by the shell (see DesktopProject). */
  creating: { kind: ContextCreateKind; scheme: ProjectContextTreeScheme } | null;
  onRequestCreate: (scheme: ProjectContextTreeScheme, kind: ContextCreateKind) => void;
  onCreateDone: () => void;
};

export function LeftSidebar({
  projectId,
  activeScreen,
  activeThreadId,
  activeContextScheme,
  activeContextPath,
  onSelectScreen,
  onSelectContextPath,
  onCollapse,
  creating,
  onRequestCreate,
  onCreateDone,
}: LeftSidebarProps) {
  const handleSelectFile = (scheme: ProjectContextTreeScheme, file: ContextFile) =>
    onSelectContextPath(file.path, scheme);

  return (
    <nav
      aria-label={t`Workspace navigation`}
      className="flex h-full min-h-0 w-full flex-col text-foreground"
    >
      {/* Wordmark — collapse (far-left) · Meridian (app home) */}
      <div className="flex h-10 shrink-0 items-center gap-1 px-2">
        <PanelToggleButton
          icon={PanelLeftClose}
          label={t`Collapse sidebar  [`}
          onClick={onCollapse}
        />
        <Link
          to="/home"
          className="focus-ring flex min-w-0 cursor-pointer items-center gap-1 rounded-md no-underline"
          aria-label={t`Home`}
        >
          <MeridianMark className="size-7" />
          <span className="text-sm font-semibold tracking-tight text-foreground">Meridian</span>
        </Link>
      </div>

      <WorkspaceNavBody
        projectId={projectId}
        activeScreen={activeScreen}
        onSelectScreen={onSelectScreen}
        presentation="desktop"
      >
        <ContextTreePanel
          projectId={projectId}
          activeThreadId={activeThreadId}
          activeScheme={activeContextScheme}
          activePath={activeContextPath}
          onSelectFile={handleSelectFile}
          creating={creating}
          onRequestCreate={onRequestCreate}
          onCreateDone={onCreateDone}
        />
      </WorkspaceNavBody>
    </nav>
  );
}
