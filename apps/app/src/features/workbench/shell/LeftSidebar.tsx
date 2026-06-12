// @ts-nocheck
/**
 * LeftSidebar — desktop workbench workspace navigation rail combining screen
 * destinations, thread access, and workbench creation. Mobile navigation uses
 * drawers instead of this persistent sidebar.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { PanelLeftClose, Plus } from "lucide-react";
import { useState } from "react";

import {
  useUpdateWorkbenchPreferences,
  useWorkbenchPreferences,
} from "@/client/query/useWorkbenchPreferences";
import { MeridianMark } from "@/components/app/MeridianMark";
import { AccountMenu } from "@/features/account/AccountMenu";
import { cn } from "@/lib/utils";
import { type ThreadFilter, ThreadPanel } from "../chat/ThreadPanel";
import { useCreateChat } from "../chat/use-create-chat";
import { PanelToggleButton } from "./PanelToggleButton";
import { SidebarSectionLabel } from "./SidebarSectionLabel";
import { SCREENS, type ScreenKey, type ScreenMeta } from "./screens";
import { ThreadSearch, ViewMenu } from "./ThreadListControls";

/**
 * LeftSidebar — content of the persistent left workbench slot (the rail owns
 * `bg-sidebar`, the rounded inside edge, and the shadow). One column:
 *
 *   wordmark (links to app home)  ·  Home/Chat/Context nav  ·  Chats controls  ·
 *   thread list (real ThreadPanel with pins)  ·  account row
 *
 * The collapse control sits at the far-left (same x as the PaneHeader expand
 * control) so toggling the rail never moves the cursor.
 */
export type LeftSidebarProps = {
  workbenchId: string;
  activeScreen: ScreenKey;
  activeThreadId: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectThread: (threadId: string) => void;
  /** Collapse the sidebar rail. */
  onCollapse: () => void;
};

export function LeftSidebar({
  workbenchId,
  activeScreen,
  activeThreadId,
  onSelectScreen,
  onSelectThread,
  onCollapse,
}: LeftSidebarProps) {
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>("all");
  const [threadSearch, setThreadSearch] = useState("");
  const { preferences } = useWorkbenchPreferences(workbenchId);
  const updatePreferences = useUpdateWorkbenchPreferences(workbenchId);
  const { createChat, creating } = useCreateChat(workbenchId, onSelectThread);

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
          to="/"
          className="focus-ring flex min-w-0 cursor-pointer items-center gap-1 rounded-md no-underline"
          aria-label={t`Home`}
        >
          <MeridianMark className="size-7" />
          <span className="text-sm font-semibold tracking-tight text-foreground">Meridian</span>
        </Link>
      </div>

      {/* Destination nav */}
      <div className="flex shrink-0 flex-col gap-0.5 px-2 pt-1">
        {SCREENS.map((screen) => (
          <NavItem
            key={screen.key}
            screen={screen}
            active={screen.key === activeScreen}
            onClick={() => onSelectScreen(screen.key)}
          />
        ))}
      </div>

      {/* Chats label + new chat · single-row search/view controls */}
      <div className="mt-3 flex shrink-0 flex-col gap-1.5 px-3 pb-1">
        <div className="flex items-center">
          <SidebarSectionLabel>
            <Trans>Chats</Trans>
          </SidebarSectionLabel>
          <button
            type="button"
            aria-label={t`New chat`}
            title={t`New chat`}
            disabled={creating}
            onClick={() => void createChat()}
            className="focus-ring ml-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground disabled:opacity-50"
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <ThreadSearch value={threadSearch} onChange={setThreadSearch} />
          <ViewMenu
            groupBy={preferences.threadGroupBy}
            groupByDisabled={updatePreferences.isPending}
            onGroupByChange={(threadGroupBy) => updatePreferences.mutate({ threadGroupBy })}
            filter={threadFilter}
            onFilterChange={setThreadFilter}
          />
        </div>
      </div>

      {/* Thread list — real data, transparent + headerless to share the rail tone */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ThreadPanel
          workbenchId={workbenchId}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectThread}
          transparent
          hideHeader
          groupBy={preferences.threadGroupBy}
          filter={threadFilter}
          searchQuery={threadSearch}
          pinnedThreadIds={preferences.pinnedThreadIds}
        />
      </div>

      <div className="shrink-0 border-t border-border-subtle px-2 py-1.5">
        <AccountMenu />
      </div>
    </nav>
  );
}

function NavItem({
  screen,
  active,
  onClick,
}: {
  screen: ScreenMeta;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = screen.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-ring flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      <span className="grid size-5 place-items-center text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{screen.label}</span>
    </button>
  );
}
