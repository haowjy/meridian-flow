/**
 * WorkspaceNavBody — shared project navigation for destination links, an
 * optional desktop body, and the account row.
 *
 * LeftSidebar (desktop persistent rail) and NavigationDrawer (phone Sheet) both
 * compose this; each owns only its chrome — the collapse control / Sheet, the
 * wordmark header, and safe-area padding. `presentation` carries the
 * desktop↔phone touch-target and spacing differences (mirroring how
 * SettingsDialog/PhoneSettings share section bodies), and "close the drawer on
 * select" stays a chrome concern: NavigationDrawer passes `onSelect*` callbacks
 * that close the sheet, so the body never needs to know it lives in one.
 */
import type { ReactNode } from "react";

import { AccountMenu } from "@/features/account/AccountMenu";
import { cn } from "@/lib/utils";
import { SCREENS, type ScreenKey, type ScreenMeta, screenLabel } from "./screens";

export type WorkspaceNavPresentation = "desktop" | "phone";

export type WorkspaceNavBodyProps = {
  activeScreen: ScreenKey;
  onSelectScreen: (screen: ScreenKey) => void;
  presentation: WorkspaceNavPresentation;
  /** Persistent navigation content between the controls and account row. */
  children?: ReactNode;
};

export function WorkspaceNavBody({
  activeScreen,
  onSelectScreen,
  presentation,
  children,
}: WorkspaceNavBodyProps) {
  const phone = presentation === "phone";

  return (
    <>
      {/* Destination nav */}
      <div
        className={cn(
          "flex shrink-0 flex-col",
          phone ? "gap-1 px-3 py-3" : "gap-0.5 border-b border-border-subtle pb-2",
        )}
      >
        {SCREENS.map((screen) => (
          <ScreenNavItem
            key={screen.key}
            screen={screen}
            active={screen.key === activeScreen}
            presentation={presentation}
            onClick={() => onSelectScreen(screen.key)}
          />
        ))}
      </div>

      <div className="min-h-0 flex-1">{children}</div>

      <div
        className={cn("shrink-0 border-t border-border-subtle px-2", phone ? "pt-2" : "py-1.5")}
        style={phone ? { paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" } : undefined}
      >
        <AccountMenu />
      </div>
    </>
  );
}

function ScreenNavItem({
  screen,
  active,
  presentation,
  onClick,
}: {
  screen: ScreenMeta;
  active: boolean;
  presentation: WorkspaceNavPresentation;
  onClick: () => void;
}) {
  const Icon = screen.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-ring flex items-center gap-2.5 text-left text-sm transition-colors",
        // Desktop rows are full-bleed square bands like the explorer headers.
        // The rail's 8px container inset moved into the row (px-2 + px-2 →
        // px-4) so the fill reaches the rail edges while icon/label x stays
        // put. The phone drawer keeps its rounded touch-target grammar.
        presentation === "phone" ? "min-h-11 rounded-md px-2 active:scale-[0.98]" : "px-4 py-1.5",
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-ink-muted hover:bg-sidebar-accent/50 hover:text-foreground",
      )}
    >
      <span className="grid size-5 place-items-center text-muted-foreground">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate">{screenLabel(screen.key)}</span>
    </button>
  );
}
