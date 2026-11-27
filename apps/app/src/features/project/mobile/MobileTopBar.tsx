import { t } from "@lingui/core/macro";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";

import { AppStatus } from "@/components/app/AppStatus";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export type MobileTopBarProps = {
  onChat: boolean;
  projectTitle: string;
  onOpenDrawer: () => void;
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  chatAction?: ReactNode;
};

export function MobileTopBar({
  onChat,
  projectTitle,
  onOpenDrawer,
  breadcrumb,
  actions,
  chatAction,
}: MobileTopBarProps) {
  const balance = !breadcrumb && Boolean(chatAction) && Boolean(actions);
  return (
    // Solid background on purpose: iOS Safari flashes `backdrop-filter` layers
    // gray when the content behind repaints wholesale, which happens on every
    // mobile view switch (views mount/unmount under this header). The content
    // beneath is a flat pane anyway, so the blur bought nothing.
    <header className="mobile-top-bar relative flex shrink-0 flex-col border-b border-border-subtle bg-background">
      <div
        className="flex h-14 items-center gap-1"
        style={{
          paddingLeft: "calc(0.5rem + env(safe-area-inset-left))",
          paddingRight: "calc(0.5rem + env(safe-area-inset-right))",
        }}
      >
        <IconButton size="sm" onClick={onOpenDrawer} label={t`Open navigation`}>
          <Menu aria-hidden />
        </IconButton>
        {balance ? <div aria-hidden className="size-11 shrink-0" /> : null}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-1">
          <div
            className="max-w-full truncate text-xs leading-4 text-muted-foreground"
            title={projectTitle}
          >
            {projectTitle}
          </div>
          <div
            className={cn(
              "flex min-h-5 max-w-full items-center text-sm font-semibold text-foreground",
              breadcrumb ? "justify-start self-stretch" : "justify-center",
            )}
          >
            {breadcrumb ?? <div className="truncate">{onChat ? t`Chat` : t`Editor`}</div>}
          </div>
        </div>
        <div className="flex min-w-11 shrink-0 items-center justify-end">
          <AppStatus />
          {chatAction}
          {actions}
        </div>
      </div>
    </header>
  );
}
