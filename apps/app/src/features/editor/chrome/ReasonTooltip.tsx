/**
 * The tooltip a greyed control answers with.
 *
 * Law 5 says grey must say why; the ruling of 2026-07-29 says it says so on
 * demand. A reason printed under every refused row is standing information the
 * writer never asked for — three of them turn a menu into a paragraph — so the
 * control keeps its label alone and the reason waits for hover or focus. Every
 * greyed surface in the editor answers in this one shape: the control's name
 * when it has no visible one, then the reason beneath it.
 *
 * A `TooltipProvider` has to be somewhere above this; menus get one from
 * `EditorMenu`, the toolbar from `DocumentToolbar`.
 */
import type { ComponentProps, ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ReasonTooltipProps = {
  /**
   * The control's name, for a control whose label is not on screen — an
   * icon-only button. A row that already reads as its label passes nothing.
   */
  name?: string;
  /** Why the control cannot run here. Null when it runs. */
  reason?: string | null;
  side?: ComponentProps<typeof TooltipContent>["side"];
  children: ReactNode;
};

export function ReasonTooltip({ name, reason, side = "right", children }: ReasonTooltipProps) {
  // Nothing to say: the control is named on screen and it runs.
  if (!name && !reason) return <>{children}</>;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      {/* Never a hit target: it hangs over the manuscript, and a click there
          means the caret goes where the writer clicked (the same reason menus
          are non-modal), not that a bubble swallowed it. */}
      <TooltipContent side={side} className="pointer-events-none max-w-56">
        {name ? <span className="block">{name}</span> : null}
        {/* Muted only under a name — alone it IS the message. */}
        {reason ? (
          <span className={cn("block", name && "text-background/70")}>{reason}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}
