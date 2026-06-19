/**
 * LeftSidebar — desktop project workspace navigation rail combining screen
 * destinations, thread access, and project creation. Mobile navigation uses
 * drawers instead of this persistent sidebar.
 *
 * Chrome only: the wordmark + collapse control and the rail `<nav>`. The shared
 * body (screens, Chats, thread list, account) lives in `WorkspaceNavBody`,
 * which NavigationDrawer also composes.
 */
import { t } from "@lingui/core/macro";
import { Link } from "@tanstack/react-router";
import { PanelLeftClose } from "lucide-react";

import { MeridianMark } from "@/components/app/MeridianMark";
import { PanelToggleButton } from "./PanelToggleButton";
import type { ScreenKey } from "./screens";
import { WorkspaceNavBody } from "./WorkspaceNavBody";

/**
 * LeftSidebar — content of the persistent left project slot (the rail owns
 * `bg-sidebar`, the rounded inside edge, and the shadow). One column:
 *
 *   wordmark (links to app home)  ·  Home/Chat/Context nav  ·  Chats controls  ·
 *   thread list (real ThreadPanel with pins)  ·  account row
 *
 * The collapse control sits at the far-left (same x as the PaneHeader expand
 * control) so toggling the rail never moves the cursor.
 */
export type LeftSidebarProps = {
  projectId: string;
  activeScreen: ScreenKey;
  activeThreadId: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectThread: (threadId: string) => void;
  /** Collapse the sidebar rail. */
  onCollapse: () => void;
};

export function LeftSidebar({
  projectId,
  activeScreen,
  activeThreadId,
  onSelectScreen,
  onSelectThread,
  onCollapse,
}: LeftSidebarProps) {
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
        activeThreadId={activeThreadId}
        onSelectScreen={onSelectScreen}
        onSelectThread={onSelectThread}
        presentation="desktop"
      />
    </nav>
  );
}
