import { PanelLeftOpen, PanelRightOpen } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { PanelToggleButton } from "./PanelToggleButton";

/**
 * PaneHeader — the thin (h-10 / 40px) chrome band at the top of a destination's
 * main pane: a far-left expand control for the left sidebar, a centered
 * title/breadcrumb, and far-right actions + an expand control for the right
 * rail. It paints NOTHING of its own — the center slot's chrome shows through
 * (same grammar as the document tab strip), and the pane's `page-sheet` body
 * rises out of it below. No bottom border: separation is tonal.
 *
 * The expand controls sit at the SAME x as each rail's in-rail close control,
 * so toggling a rail never moves the cursor ("click without moving the mouse").
 * When a rail is open its own header owns the close button and this renders
 * nothing in that slot — no reserved spacer; title/actions take the space.
 * (The cursor trick is between the two buttons' screen positions and doesn't
 * need the slot held open.)
 */
export type PaneHeaderRailToggle = {
  open: boolean;
  onExpand: () => void;
  label: string;
};

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
};

export function PaneHeader({ title, left, right, actions, leading }: PaneHeaderProps) {
  const leftToggle = left && !left.open;
  return (
    <header className="flex h-10 shrink-0 items-center gap-1 px-2">
      {leftToggle ? (
        <PanelToggleButton icon={PanelLeftOpen} label={left.label} onClick={left.onExpand} />
      ) : null}
      {leading ? (
        // The tab strip puts its first chip flush at the pane edge, or 8px past
        // the toggle's own px-2 zone; the offsets land on those same x values.
        // -mr-1 cancels the gap so the title chip sits flush like a next tab.
        <div className={cn("-mr-1 flex shrink-0 self-stretch", leftToggle ? "ml-1" : "-ml-2")}>
          {leading}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 items-center">{title}</div>

      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {right && !right.open ? (
          <PanelToggleButton icon={PanelRightOpen} label={right.label} onClick={right.onExpand} />
        ) : null}
      </div>
    </header>
  );
}
