/**
 * MobileTopBar — status-bar-aware project header for the phone shell.
 *
 * Owns only mobile navigation chrome. The drawer trigger (hamburger) is
 * unconditional — there is no back chevron anywhere; up-navigation happens
 * through breadcrumb ancestors, and OS/browser back pops levels because
 * drill-in is route-driven. Screens with a location trail (Files, and Chats ›
 * chat on the Chat screen) supply a breadcrumb, which sits left-aligned right
 * after the hamburger and takes the remaining row width. Screens without one
 * (Work, or the routed Results auxiliary surface) get a centered title: the
 * leading side reserves as many 44px slots as the trailing side, so the title
 * stays truly centered even with the chat door beside the actions.
 * Desktop pane headers stay separate.
 */
import { t } from "@lingui/core/macro";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { cn } from "@/lib/utils";
import type { ProjectViewProps } from "../ProjectView";
import { screenLabel } from "../shell/screens";

export type MobileTopBarProps = Pick<ProjectViewProps, "activeScreen"> & {
  projectTitle: string;
  onOpenDrawer: () => void;
  /** Left-aligned location trail; replaces the centered title when set. */
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  /** Opens the chat sheet over Work or Editor. */
  chatAction?: ReactNode;
  title?: ReactNode;
};

export function MobileTopBar({
  activeScreen,
  projectTitle,
  onOpenDrawer,
  breadcrumb,
  actions,
  chatAction,
  title,
}: MobileTopBarProps) {
  // Two trailing controls need a matching 44px reserve on the leading side.
  const balance = !breadcrumb && Boolean(chatAction) && Boolean(actions);
  return (
    // Solid background on purpose: iOS Safari flashes `backdrop-filter` layers
    // gray when the content behind repaints wholesale, which happens on every
    // mobile view switch (views mount/unmount under this header). The content
    // beneath is a flat pane anyway, so the blur bought nothing.
    <header className="mobile-top-bar flex shrink-0 flex-col border-b border-border-subtle bg-background">
      <div
        className="flex h-14 items-center gap-1"
        style={{
          paddingLeft: "calc(0.5rem + env(safe-area-inset-left))",
          paddingRight: "calc(0.5rem + env(safe-area-inset-right))",
        }}
      >
        <PhoneIconButton onClick={onOpenDrawer} aria-label={t`Open navigation`}>
          <Menu className="size-5" aria-hidden />
        </PhoneIconButton>
        {balance ? <div aria-hidden className="size-11 shrink-0" /> : null}
        <div className="flex min-w-0 flex-1 flex-col items-center justify-center px-1">
          <div
            className="max-w-full truncate text-xs leading-4 text-ink-muted"
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
            {breadcrumb ?? (
              <div className="truncate" title={typeof title === "string" ? title : undefined}>
                {title ?? screenLabel(activeScreen)}
              </div>
            )}
          </div>
        </div>
        <div className="flex min-w-11 shrink-0 items-center justify-end">
          {chatAction}
          {actions}
        </div>
      </div>
    </header>
  );
}
