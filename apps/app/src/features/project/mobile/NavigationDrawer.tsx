/**
 * NavigationDrawer — phone project drawer for screens, chats, and account.
 *
 * Reuses the real ThreadPanel and account menu inside a Sheet so mobile
 * navigation shares data and actions with the desktop sidebar without mounting
 * the desktop grid shell.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  useProjectPreferences,
  useUpdateProjectPreferences,
} from "@/client/query/useProjectPreferences";
import { MeridianMark } from "@/components/app/MeridianMark";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { AccountMenu } from "@/features/account/AccountMenu";
import { cn } from "@/lib/utils";
import { type ThreadFilter, ThreadPanel } from "../chat/ThreadPanel";
import { useCreateChat } from "../chat/use-create-chat";
import { SidebarSectionLabel } from "../shell/SidebarSectionLabel";
import { SCREENS, type ScreenKey, type ScreenMeta } from "../shell/screens";
import { ThreadSearch, ViewMenu } from "../shell/ThreadListControls";

export type NavigationDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  activeScreen: ScreenKey;
  activeThreadId: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectThread: (threadId: string) => void;
};

export function NavigationDrawer({
  open,
  onOpenChange,
  projectId,
  activeScreen,
  activeThreadId,
  onSelectScreen,
  onSelectThread,
}: NavigationDrawerProps) {
  const [threadFilter, setThreadFilter] = useState<ThreadFilter>("all");
  const [threadSearch, setThreadSearch] = useState("");
  const { preferences } = useProjectPreferences(projectId);
  const updatePreferences = useUpdateProjectPreferences(projectId);
  const { createChat, creating } = useCreateChat(projectId, (threadId) => {
    onSelectThread(threadId);
    onOpenChange(false);
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        showCloseButton={false}
        // Radix Dialog auto-focuses the first focusable on open; with the close
        // button hidden that's a nav item, and iOS Safari paints :focus-visible
        // on that programmatic focus. Prevent the default, then focus the sheet
        // container itself (event.target — Radix dispatches this event on the
        // content element, which has tabIndex=-1 via FocusScope). The explicit
        // focus matters: Radix's focus trap only engages once focus enters the
        // scope, so preventDefault alone lets Tab escape to content behind the
        // overlay. Keyboard tabbing from here still rings nav items as usual.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.target as HTMLElement | null)?.focus({ preventScroll: true });
        }}
        // Width leaves a >=56px scrim tap target on small phones (375px ->
        // 319px drawer); 320px cap matches standard mobile nav-drawer sizing.
        // The animated SheetContent stays visually bare (transparent, no
        // radius/clip/shadow): WebKit has a compositing bug where
        // overflow:hidden + border-radius on a transform-animated element drops
        // child content (blank rects) while rasterizing during the slide. All
        // drawer chrome lives on the full-size inner wrapper below instead.
        className="w-[85vw] max-w-[320px] gap-0 border-r-0 bg-transparent p-0 text-foreground shadow-none"
      >
        <SheetTitle className="visually-hidden">
          <Trans>Workspace navigation</Trans>
        </SheetTitle>
        <SheetDescription className="visually-hidden">
          <Trans>Switch screens, open chats, or manage your account.</Trans>
        </SheetDescription>
        {/* Chrome wrapper — rounded-r-xl + shadow-rail-left carry the desktop
            rail chrome (desktop-layout.ts) instead of a hairline border. It is
            NOT the animated element (see WebKit note above), so it can safely
            clip; safe-area paddings live here so the drawer background still
            fills under the notch/home-indicator regions. */}
        <div
          className="flex h-full min-h-0 flex-col overflow-hidden rounded-r-xl bg-sidebar shadow-rail-left"
          style={{
            paddingTop: "env(safe-area-inset-top)",
            paddingLeft: "env(safe-area-inset-left)",
            paddingRight: "env(safe-area-inset-right)",
          }}
        >
          <nav aria-label={t`Workspace navigation`} className="flex h-full min-h-0 flex-col">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
              <Link
                to="/"
                className="focus-ring flex min-w-0 items-center gap-1 rounded-md no-underline"
                aria-label={t`Home`}
                onClick={() => onOpenChange(false)}
              >
                <MeridianMark className="size-7" />
                <span className="text-sm font-semibold tracking-tight text-foreground">
                  Meridian
                </span>
              </Link>
            </div>

            <div className="flex shrink-0 flex-col gap-1 px-3 py-3">
              {SCREENS.map((screen) => (
                <NavItem
                  key={screen.key}
                  screen={screen}
                  active={screen.key === activeScreen}
                  onClick={() => {
                    onSelectScreen(screen.key);
                    onOpenChange(false);
                  }}
                />
              ))}
            </div>

            <div className="flex shrink-0 flex-col gap-1.5 border-t border-border-subtle px-3 py-3">
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
                  className="focus-ring ml-auto grid size-11 place-items-center rounded-md text-muted-foreground transition-colors active:scale-[0.98] hover:bg-sidebar-accent/60 hover:text-foreground disabled:opacity-50"
                >
                  <span className="text-lg leading-none">+</span>
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

            <div className="min-h-0 flex-1">
              <ThreadPanel
                projectId={projectId}
                activeThreadId={activeThreadId}
                onSelectThread={(threadId) => {
                  onSelectThread(threadId);
                  onOpenChange(false);
                }}
                transparent
                hideHeader
                groupBy={preferences.threadGroupBy}
                filter={threadFilter}
                searchQuery={threadSearch}
                pinnedThreadIds={preferences.pinnedThreadIds}
              />
            </div>

            <div
              className="shrink-0 border-t border-border-subtle px-2 pt-2"
              style={{ paddingBottom: "calc(0.5rem + env(safe-area-inset-bottom))" }}
            >
              <AccountMenu />
            </div>
          </nav>
        </div>
      </SheetContent>
    </Sheet>
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
        "focus-ring flex min-h-11 items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors active:scale-[0.98]",
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
