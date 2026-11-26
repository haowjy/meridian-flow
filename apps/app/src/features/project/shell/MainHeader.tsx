import { t } from "@lingui/core/macro";
import { History, MessageSquare, PenLine } from "lucide-react";
import type { ReactNode } from "react";
import type { MainTab, MainTabKind } from "@/client/project-shell/main-tabs";
import { AppStatus } from "@/components/app/AppStatus";
import { role } from "@/components/ui/roles";
import { holdFocus } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";
import type { OpenContextRoute } from "../routing/ProjectNavigationContext";
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
  kind: MainTabKind;
  mainTab?: MainTab;
  landing?: boolean;
  keepMain?: boolean;
  current?: ReactNode;
  onShowRecents: () => void;
  onNew?: () => void;
  sidebarToggle: PaneHeaderRailToggle;
  sideToggle: PaneHeaderRailToggle;
  actions?: ReactNode;
}) {
  return (
    <PaneHeader
      left={sidebarToggle}
      right={sideToggle}
      leading={
        <>
          <ModeLabel kind={kind} />
          <RecentlyOpenedDoor kind={kind} active={landing} onClick={onShowRecents} />
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
            onNew={onNew}
          />
          <MainTabMenu
            projectId={projectId}
            kind={kind}
            open={open}
            mainTab={mainTab}
            keepMain={keepMain || landing}
          />
        </div>
      }
      actions={
        <>
          <AppStatus />
          {actions}
        </>
      }
    />
  );
}

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
