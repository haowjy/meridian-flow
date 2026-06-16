/**
 * MobileTopBar — status-bar-aware project header for the phone shell.
 *
 * Owns only mobile navigation chrome. The drawer trigger (hamburger) is
 * unconditional — there is no back chevron anywhere; up-navigation happens
 * through breadcrumb ancestors, and OS/browser back pops levels because
 * drill-in is route-driven. Screens with a location trail (the context
 * screen) supply a breadcrumb, which sits left-aligned right after the
 * hamburger and takes the remaining row width. Screens without one (home,
 * chat, or the routed Results auxiliary surface) get a centered title — the
 * leading button slot and the trailing actions reserve are both exactly 44px,
 * so the title stays truly centered.
 * Desktop pane headers stay separate.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ThreadListItem } from "@meridian/contracts/protocol";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";

import { PhoneIconButton } from "@/components/ui/phone-icon-button";
import { displayThreadTitle } from "@/lib/thread-title";
import { cn } from "@/lib/utils";
import type { ProjectViewProps } from "../ProjectView";

export type MobileTopBarProps = Pick<ProjectViewProps, "activeScreen"> & {
  activeThread: ThreadListItem | null;
  onOpenDrawer: () => void;
  /** Left-aligned location trail; replaces the centered title when set. */
  breadcrumb?: ReactNode;
  actions?: ReactNode;
  title?: ReactNode;
};

export function MobileTopBar({
  activeScreen,
  activeThread,
  onOpenDrawer,
  breadcrumb,
  actions,
  title,
}: MobileTopBarProps) {
  return (
    // Solid background on purpose: iOS Safari flashes `backdrop-filter` layers
    // gray when the content behind repaints wholesale, which happens on every
    // mobile view switch (views mount/unmount under this header). The content
    // beneath is a flat pane anyway, so the blur bought nothing.
    <header className="mobile-top-bar flex shrink-0 flex-col border-b border-border-subtle bg-background">
      <div
        className="flex h-12 items-center gap-1"
        style={{
          paddingLeft: "calc(0.5rem + env(safe-area-inset-left))",
          paddingRight: "calc(0.5rem + env(safe-area-inset-right))",
        }}
      >
        <PhoneIconButton onClick={onOpenDrawer} aria-label={t`Open navigation`}>
          <Menu className="size-5" aria-hidden />
        </PhoneIconButton>
        {/* Breadcrumb is left-aligned (a location trail reads from its root);
            plain titles stay centered between the 44px leading/trailing slots. */}
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center",
            breadcrumb ? "justify-start" : "justify-center",
          )}
        >
          {breadcrumb ?? (
            <div className="truncate text-sm font-semibold text-foreground">
              {title ?? titleFor({ activeScreen, activeThread })}
            </div>
          )}
        </div>
        <div
          className={cn("flex size-11 shrink-0 items-center justify-end", !actions && "invisible")}
        >
          {actions}
        </div>
      </div>
    </header>
  );
}

/**
 * Centered titles for breadcrumb-less screens. The context screen always
 * supplies a breadcrumb (its root renders as a lone "Files" crumb), so no
 * context title exists here.
 */
function titleFor({
  activeScreen,
  activeThread,
}: Pick<MobileTopBarProps, "activeScreen" | "activeThread">) {
  if (activeScreen === "chat") {
    return activeThread?.title ? displayThreadTitle(activeThread.title) : <Trans>Chat</Trans>;
  }
  return <Trans>Project</Trans>;
}
