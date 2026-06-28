/**
 * RailHeader — the shared header bar for a contextual overlay rail.
 *
 * One thin primitive so every rail's header is structurally identical: a fixed
 * `h-10` bar (the canonical project header height) with a `border-b`, a
 * leading content slot (a label, a thread
 * switcher, …), and a trailing collapse control on the rail's inside-facing
 * edge. Used by the Context rail (`ContextSidebar`) and the chat dock
 * (`ChatSurface` dock placement) so the close affordance lands in the same spot,
 * with the same icon + size, across every rail. ("Looks like the context
 * sidebar" — captured once, not re-styled per rail.)
 *
 * Not a full "rail shell": the coplanar float treatment lives on the slot container
 * (a `ResizablePanel` wrapper), and the chat dock is a gliding `motion.div` that
 * can't be a panel — so only the HEADER is shared, which is the part that
 * actually repeats. `side` only selects the collapse glyph; both current rails
 * sit on the right.
 */
import { PanelLeftClose, PanelRightClose } from "lucide-react";
import type { ReactNode } from "react";

import { PanelToggleButton } from "./PanelToggleButton";

export type RailHeaderProps = {
  /** Leading content — a section label, a thread switcher, etc. */
  children: ReactNode;
  /** Trailing actions, rendered before the collapse control (mirrors PaneHeader). */
  actions?: ReactNode;
  /** Collapse the rail. */
  onClose: () => void;
  /** Accessible name + native title for the collapse control (i18n-ready). */
  closeLabel: string;
  /** Which edge the rail sits on → which collapse glyph. Defaults to right. */
  side?: "left" | "right";
};

export function RailHeader({
  children,
  actions,
  onClose,
  closeLabel,
  side = "right",
}: RailHeaderProps) {
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-2">
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        <PanelToggleButton
          icon={side === "left" ? PanelLeftClose : PanelRightClose}
          label={closeLabel}
          onClick={onClose}
        />
      </div>
    </header>
  );
}
