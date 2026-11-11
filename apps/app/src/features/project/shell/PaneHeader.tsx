import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { PanelToggleSpacer } from "./PanelToggleButton";

/**
 * PaneHeader — the thin (h-10 / 40px) chrome band at the top of a destination's
 * main pane: a far-left expand control for the left sidebar, a centered
 * title/breadcrumb, and far-right actions + an expand control for the right
 * rail. It paints NOTHING of its own — the center slot's chrome shows through
 * (same grammar as the document tab strip), and the pane's `page-sheet` body
 * rises out of it below. No bottom border: the sheet draws its own edge, and
 * the band overlaps it so an active chip covers that edge (`tab-band`).
 *
 * The panel toggles are the shell's corner buttons (`ProjectShell`). When a
 * rail is closed its toggle floats over this band, so the band reserves its
 * place; when it is open the toggle floats over the rail instead.
 *
 * A `notice` (a failed command on the pane's subject, like a rejected rename or
 * Archive) sits beside the title when the pane is wide, and floats under the
 * band when the pane is narrow, so the title keeps its width and the band stays
 * one row: a taller band would lift the active title tab off the page. It is
 * one element whose position alone changes, so crossing the width neither
 * remounts it (its alert is not announced again) nor drops focus from its Retry.
 */
export type PaneHeaderRailToggle = { open: boolean };

export type PaneHeaderProps = {
  title: ReactNode;
  /** Left sidebar toggle (far-left). Omit when the pane has no left rail. */
  left?: PaneHeaderRailToggle;
  /** Right rail toggle (far-right). Omit when the pane has no right rail. */
  right?: PaneHeaderRailToggle;
  /** Right-aligned actions (e.g. share), before the right toggle. */
  actions?: ReactNode;
  /**
   * Full-height chip right after the left toggle (the chat index door). Placed
   * on the same x as the Editor's Recently opened chip in both sidebar states.
   */
  leading?: ReactNode;
  /** A failed command's row; placement follows the pane's width. */
  notice?: ReactNode;
};

export function PaneHeader({ title, left, right, actions, leading, notice }: PaneHeaderProps) {
  const leftToggle = left && !left.open;
  return (
    <div className="@container/pane-header tab-band shrink-0">
      <header className="flex items-center gap-x-1 pr-2">
        {leftToggle ? <PanelToggleSpacer /> : null}
        {leading ? (
          // The same x as the tab strip's first chip in both sidebar states: the
          // band's gutter, or just past the toggle. -mr-1 cancels the gap so the
          // title chip sits flush like a next tab.
          <div className={cn("-mr-1 flex shrink-0 self-stretch", leftToggle && "-ml-0.5")}>
            {leading}
          </div>
        ) : null}

        {/* Band-tall, so a title chip can stretch into an inactive tab's full-height hover. */}
        {/* Relative: a refused title rename floats under the band from here. */}
        <div
          className={cn(
            "relative flex h-10 min-w-0 flex-1 items-center",
            notice && "@2xl/pane-header:flex-initial",
          )}
        >
          {title}
        </div>
        {notice ? (
          <div className="absolute inset-x-2 top-full z-20 mt-1 rounded-md border border-border bg-card shadow-float @2xl/pane-header:static @2xl/pane-header:z-auto @2xl/pane-header:mt-0 @2xl/pane-header:min-w-0 @2xl/pane-header:flex-initial @2xl/pane-header:rounded-none @2xl/pane-header:border-0 @2xl/pane-header:bg-transparent @2xl/pane-header:shadow-none">
            {notice}
          </div>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {actions}
          {right && !right.open ? <PanelToggleSpacer /> : null}
        </div>
      </header>
    </div>
  );
}
