/**
 * MainHeader — the band above main's page, whatever main holds: main's mode, the Recently opened door, main's
 * tabs (the page rises into the active one), the removed-documents notice, and main's item's own
 * controls.
 */
import { t } from "@lingui/core/macro";
import { History, MessageSquare, PenLine } from "lucide-react";
import type { ReactNode } from "react";
import type { MainTab, MainTabKind } from "@/client/project-shell/main-tabs";
import { role } from "@/components/ui/roles";
import { holdFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import { RemovedDocumentChip, RemovedNoticeSlot } from "../context/RemovedDocumentNotice";
import { useChatNavigation } from "../routing/chat-navigation";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
import type { ProjectRouteCommands } from "../routing/project-route";
import { BandIconButton } from "./BandIconButton";
import { MainTabMenu, MainTabStrip } from "./MainTabStrip";
import { PaneHeader, type PaneHeaderRailToggle } from "./PaneHeader";

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
  /** Main is its lane's Recently opened page: the door is the current place. */
  landing?: boolean;
  /** Main is on its lane's empty page (the new-chat composer): Close all leaves it there. */
  keepMain?: boolean;
  /** Main's item when it takes no tab (an address that names nothing, the Trash). */
  current?: ReactNode;
  /** The document lane's Recently opened; the chat lane's door opens Recent chats. */
  onShowRecents: ProjectRouteCommands["showEditorRecents"];
  /** Absent while no Work is ready to hold an Untitled document. */
  onNew?: () => void;
  sidebarToggle: PaneHeaderRailToggle;
  sideToggle: PaneHeaderRailToggle;
  /** Main's item's own controls, before the side's. */
  actions?: ReactNode;
}) {
  const chat = useChatNavigation();
  return (
    <PaneHeader
      left={sidebarToggle}
      right={sideToggle}
      leading={
        <>
          <ModeLabel kind={kind} />
          <RecentlyOpenedDoor
            kind={kind}
            active={landing}
            onClick={() =>
              kind === "chat" ? chat.openRecents() : onShowRecents({ replace: false })
            }
          />
        </>
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

/** Main's mode, named in the switch's words, so the band says what kind of page this is. */
function ModeLabel({ kind }: { kind: MainTabKind }) {
  const Icon = kind === "chat" ? MessageSquare : PenLine;
  return (
    <span
      data-main-mode={kind}
      className={cn(role.row, "flex shrink-0 items-center gap-1.5 self-center px-2 font-medium")}
    >
      <Icon className={cn("size-3.5", role.secondary)} aria-hidden />
      {kind === "chat" ? t`Chat` : t`Write`}
    </span>
  );
}

/**
 * The door to the lane's recent page (Recently opened documents, Recent chats), icon only, right
 * after the sidebar toggle. Current while that page is the page below (the page rises into it).
 */
function RecentlyOpenedDoor({
  kind,
  active,
  onClick,
}: {
  kind: MainTabKind;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <BandIconButton
      label={kind === "chat" ? t`Recent chats` : t`Recently opened`}
      active={active}
      data-recents-door
      onClick={(event) => {
        const focused = event.currentTarget === document.activeElement;
        onClick();
        // The landing is main's own page with its own header: the focus follows to its door.
        if (focused) holdFocus(() => document.querySelector("[data-recents-door][aria-current]"));
      }}
    >
      <History aria-hidden />
    </BandIconButton>
  );
}
