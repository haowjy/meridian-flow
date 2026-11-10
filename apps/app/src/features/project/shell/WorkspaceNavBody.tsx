/**
 * WorkspaceNavBody — the phone drawer's body: destination links, the sources
 * (`children`), and the account row. `NavigationDrawer` owns the Sheet and
 * closes it on select; this body never needs to know it lives in one.
 */
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { AccountMenu } from "@/features/account/AccountMenu";
import { cn } from "@/lib/utils";
import { sidebarIcon, sidebarRole } from "../context/context-row-geometry";
import { useRailSwitchFailed } from "../routing/document-switch-failure";
import { SCREENS, type ScreenKey, type ScreenMeta, screenLabel } from "./screens";

export function WorkspaceNavBody({
  activeScreen,
  onSelectScreen,
  children,
}: {
  activeScreen: ScreenKey;
  onSelectScreen: (screen: ScreenKey) => void;
  /** The sources, between the destinations and the account row. */
  children?: ReactNode;
}) {
  const failed = useRailSwitchFailed();

  return (
    <>
      <div className="flex shrink-0 flex-col gap-1 px-3 py-3">
        {SCREENS.map((screen) => (
          <div key={screen.key}>
            <ScreenNavItem
              screen={screen}
              active={screen.key === activeScreen}
              onClick={() => onSelectScreen(screen.key)}
            />
            {failed === screen.key && (
              <p role="alert" className="px-2 py-1 text-xs text-destructive">
                <Trans>This view couldn’t open.</Trans>
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border-subtle pt-1">
        {children}
      </div>

      <div
        className="shrink-0 border-t border-border-subtle px-2 pt-2"
        style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
      >
        {/* The account sits before the way out, so a near miss never leaves the project. */}
        <AccountMenu />
        <Link
          to="/"
          className={cn(
            "focus-ring flex min-h-11 items-center gap-2 rounded-md px-2 no-underline hover:text-foreground",
            sidebarRole.row,
            sidebarRole.secondary,
            sidebarRole.hover,
          )}
        >
          <ArrowLeft className={cn(sidebarIcon.action, "shrink-0")} aria-hidden />
          <Trans>View projects</Trans>
        </Link>
      </div>
    </>
  );
}

function ScreenNavItem({
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
        "focus-ring flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors active:scale-[0.98]",
        sidebarRole.row,
        active
          ? cn(sidebarRole.selected, "font-medium text-foreground")
          : cn(sidebarRole.secondary, sidebarRole.hover, "hover:text-foreground"),
      )}
    >
      <span className="grid size-5 place-items-center">
        <Icon className={sidebarIcon.action} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{screenLabel(screen.key)}</span>
    </button>
  );
}
