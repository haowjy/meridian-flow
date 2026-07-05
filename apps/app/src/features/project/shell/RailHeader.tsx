/**
 * RailHeader — the shared header bar for a contextual overlay rail.
 *
 * One thin primitive so every rail's header is structurally identical: a fixed
 * `h-10` bar (the canonical project header height) with a `border-b`, a
 * leading content slot (a label, a thread
 * switcher, …), and a trailing collapse control. Used by the Context rail (`ContextSidebar`) and the chat dock
 * (`ChatSurface` dock placement) so the close affordance lands in the same spot,
 * with the same icon + size, across every rail. ("Looks like the context
 * sidebar" — captured once, not re-styled per rail.)
 *
 * Not a full "rail shell": the coplanar float treatment lives on the slot container
 * (a `ResizablePanel` wrapper), and the chat dock is a gliding `motion.div` that
 * can't be a panel — so only the HEADER is shared, which is the part that
 * actually repeats. Both current rails sit on the right.
 */
import { PanelRightClose } from "lucide-react";
import type { ReactNode } from "react";

import { PanelToggleButton } from "./PanelToggleButton";

type RailHeaderProps = {
  /** Leading content — a section label, a thread switcher, etc. */
  children: ReactNode;
  /** Collapse the rail. */
  onClose: () => void;
  /** Accessible name + native title for the collapse control (i18n-ready). */
  closeLabel: string;
};

export function RailHeader({ children, onClose, closeLabel }: RailHeaderProps) {
  return (
    <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border-subtle px-2">
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
      <PanelToggleButton icon={PanelRightClose} label={closeLabel} onClick={onClose} />
    </header>
  );
}
