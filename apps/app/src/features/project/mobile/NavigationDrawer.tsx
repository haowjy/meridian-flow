/**
 * NavigationDrawer — phone project drawer for destinations and account.
 */
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { Link } from "@tanstack/react-router";
import { MeridianMark } from "@/components/app/MeridianMark";
import { useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { ContextTreePanel } from "../context/ContextTreePanel";
import type { ContextCreateKind } from "../context/context-create-kind";
import type { ContextFile } from "../context/context-tree";
import type { ScreenKey } from "../shell/screens";
import { WorkspaceNavBody } from "../shell/WorkspaceNavBody";

export type NavigationDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  activeScreen: ScreenKey;
  activeThreadId: string | null;
  activeContextScheme: ProjectContextTreeScheme | null;
  activeContextPath: string | null;
  onSelectScreen: (screen: ScreenKey) => void;
  onSelectContextPath: (path: string, scheme?: ProjectContextTreeScheme) => void;
};

export function NavigationDrawer({
  open,
  onOpenChange,
  projectId,
  activeScreen,
  activeThreadId,
  activeContextScheme,
  activeContextPath,
  onSelectScreen,
  onSelectContextPath,
}: NavigationDrawerProps) {
  const handleSelectFile = (scheme: ProjectContextTreeScheme, file: ContextFile) => {
    onSelectContextPath(file.path, scheme);
    onOpenChange(false);
  };
  // The drawer owns its own inline-create state: the desktop shell's shared
  // creation seam (empty state → sidebar) has no phone counterpart — phone
  // creation starts from the tree's own hover actions inside this drawer.
  const [creating, setCreating] = useState<{
    kind: ContextCreateKind;
    scheme: ProjectContextTreeScheme;
  } | null>(null);
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
          <Trans>Switch screens or manage your account.</Trans>
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
                to="/home"
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

            {/* Selecting a destination also closes the drawer — a chrome
                concern the shared body stays unaware of. */}
            <WorkspaceNavBody
              projectId={projectId}
              activeScreen={activeScreen}
              onSelectScreen={(screen) => {
                onSelectScreen(screen);
                onOpenChange(false);
              }}
              presentation="phone"
            >
              <ContextTreePanel
                projectId={projectId}
                activeThreadId={activeThreadId}
                activeScheme={activeContextScheme}
                activePath={activeContextPath}
                onSelectFile={handleSelectFile}
                creating={creating}
                onRequestCreate={(scheme, kind) => setCreating({ kind, scheme })}
                onCreateDone={() => setCreating(null)}
              />
            </WorkspaceNavBody>
          </nav>
        </div>
      </SheetContent>
    </Sheet>
  );
}
