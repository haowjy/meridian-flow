/**
 * MainHeader — the band above main's page, whatever main holds: the Recently opened door, main's
 * tabs (the page rises into the active one), the removed-documents notice, and main's item's own
 * controls.
 */
import { t } from "@lingui/core/macro";
import { History } from "lucide-react";
import type { ReactNode } from "react";
import type { MainTab, MainTabKind } from "@/client/project-shell/main-tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { holdFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { RemovedDocumentChip, RemovedNoticeSlot } from "../context/RemovedDocumentNotice";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import type { ProjectRouteCommands } from "../routing/project-route";
import { MainTabMenu, MainTabStrip } from "./MainTabStrip";
import { PaneHeader, type PaneHeaderRailToggle } from "./PaneHeader";
import { tabChipClass } from "./tab-chip";

export function MainHeader({
  projectId,
  open,
  kind,
  mainTab,
  landing = false,
  keepMain = false,
  current,
  onShowRecents,
  onNew,
  sidebarToggle,
  sideToggle,
  actions,
}: {
  projectId: string;
  open: OpenContextRoute;
  /** The lane the band draws: documents in Write, chats in Chat. */
  kind: MainTabKind;
  /** The item main shows in that lane, if any. */
  mainTab?: MainTab;
  /** Main is the Recently opened landing: the door is the current place. */
  landing?: boolean;
  /** Main is on its lane's empty page (the new-chat composer): Close all leaves it there. */
  keepMain?: boolean;
  /** Main's item when it takes no tab (an address that names nothing, the Trash). */
  current?: ReactNode;
  onShowRecents: ProjectRouteCommands["showEditorRecents"];
  /** Absent while no Work is ready to hold an Untitled document. */
  onNew?: () => void;
  sidebarToggle: PaneHeaderRailToggle;
  sideToggle: PaneHeaderRailToggle;
  /** Main's item's own controls, before the side's. */
  actions?: ReactNode;
}) {
  return (
    <PaneHeader
      left={sidebarToggle}
      right={sideToggle}
      leading={
        <RecentlyOpenedDoor active={landing} onClick={() => onShowRecents({ replace: false })} />
      }
      title={
        <div className="flex h-full min-w-0 flex-1 items-stretch">
          <MainTabStrip
            projectId={projectId}
            kind={kind}
            open={open}
            mainTab={mainTab}
            current={current}
            onShowRecents={onShowRecents}
            onNew={onNew}
          />
          <RemovedNoticeSlot>
            <RemovedDocumentChip projectId={projectId} />
          </RemovedNoticeSlot>
          <MainTabMenu
            projectId={projectId}
            kind={kind}
            open={open}
            mainTab={mainTab}
            keepMain={keepMain || landing}
            onShowRecents={onShowRecents}
          />
        </div>
      }
      actions={actions}
    />
  );
}

/**
 * The door to Recently opened, icon only, right after the sidebar toggle. Current while the
 * landing is the page below (the page rises into it).
 */
function RecentlyOpenedDoor({ active, onClick }: { active: boolean; onClick: () => void }) {
  const label = t`Recently opened`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={(event) => {
            const focused = event.currentTarget === document.activeElement;
            onClick();
            // The landing is main's own page with its own header: the focus follows to its door.
            if (focused)
              holdFocus(() => document.querySelector("[data-recents-door][aria-current]"));
          }}
          data-recents-door
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn("focus-ring shrink-0", tabChipClass(active))}
        >
          <History className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
