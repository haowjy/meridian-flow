import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { PanelToggleSpacer } from "./PanelToggleButton";

/**
 * PaneHeader — the chrome band at the top of a pane, main's or the side's: a
 * far-left expand control for the left sidebar, the title, and far-right
 * actions + an expand control for the right rail. Its height is the band's
 * (`tab-band`), never its content's, so the two panes' pages start level. It paints NOTHING of its own — the center slot's chrome shows through
 * (same grammar as main's header), and the pane's `page-sheet` body
 * rises out of it below. No bottom border: the sheet draws its own edge, and
 * the band overlaps it so an active chip covers that edge (`tab-band`).
 *
 * The panel toggles are the shell's corner buttons (`ProjectShell`). When a
 * rail is closed its toggle floats over this band, so the band reserves its
 * place; when it is open the toggle floats over the rail instead.
 *
 * A `notice` (a failure on what the pane shows) floats under the band at every
 * width, as a refused title rename does: in the band it would wrap and lift the
 * active title tab off the page, and between band and page it would push this
 * pane's page below the other's.
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
   * Full-height chip right after the left toggle (main's Recently opened door), at the same x
   * in both sidebar states.
   */
  leading?: ReactNode;
  /** A failure on what the pane shows; floats under the band. */
  notice?: ReactNode;
};

export function PaneHeader({ title, left, right, actions, leading, notice }: PaneHeaderProps) {
  const leftToggle = left && !left.open;
  return (
    <div className="tab-band shrink-0">
      <header className="flex h-full items-center gap-x-1 pr-2">
        {leftToggle ? <PanelToggleSpacer /> : null}
        {leading ? (
          // The same x as main's header's first chip in both sidebar states: the
          // band's gutter, or just past the toggle. -mr-1 cancels the gap so the
          // title chip sits flush beside it.
          <div className={cn("-mr-1 flex shrink-0 self-stretch", leftToggle && "-ml-0.5")}>
            {leading}
          </div>
        ) : null}

        {/* Band-tall, so a title chip can stretch into an inactive tab's full-height hover. */}
        {/* Relative: a refused title rename floats under the band from here. */}
        <div className="relative flex min-w-0 flex-1 items-center self-stretch">{title}</div>

        {/* Band-tall too, so an inactive chip among the actions has its full-height pill. */}
        <div className="ml-auto flex shrink-0 items-center gap-1 self-stretch">
          {actions}
          {right && !right.open ? <PanelToggleSpacer /> : null}
        </div>
      </header>
      {notice ? (
        <div className="absolute inset-x-2 top-full z-20 mt-1 rounded-md border border-border bg-card shadow-float">
          {notice}
        </div>
      ) : null}
    </div>
  );
}
