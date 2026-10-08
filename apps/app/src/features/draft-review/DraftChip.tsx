/**
 * DraftChip — the one control a pending draft is entered and left by, in its
 * two states. Pending: "Review draft" on a live document, a button that opens
 * the review. Reviewing: "Draft" with a chevron, the trigger of the draft menu
 * (`DraftSwitcher`). Same jade pill, same dot and box in both, so the control
 * the writer clicked to get in is still where they look to get out.
 *
 * Presentational: `DraftChipFace` is the pill; the caller wraps it in the
 * button or menu trigger that owns the click, focus ring and hit area (the
 * wrapper carries `group/chip` so the face can answer hover and open).
 */
import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";

import { IDENTITY_BAR_BOX_CLASS } from "@/features/project/context/identity-bar-geometry";
import { cn } from "@/lib/utils";

export type DraftChipState = "pending" | "reviewing" | "failed";

const TONE: Record<DraftChipState, string> = {
  pending: "border-primary/30 bg-primary/10 text-jade-text group-hover/chip:bg-primary/15",
  reviewing:
    "border-primary/40 bg-primary/15 text-jade-text group-hover/chip:bg-primary/20 group-data-[state=open]/chip:bg-primary/25",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
};

/** The wrapper's hit area: the pill itself on desktop, a 44px target around it on a phone. */
export function draftChipHitClass(touch: boolean): string {
  return cn(
    "focus-ring group/chip shrink-0 rounded-md",
    touch ? "flex min-h-11 items-center" : "ml-1",
  );
}

export function DraftChipFace({
  state,
  menu = false,
  touch = false,
  children,
}: {
  state: DraftChipState;
  /** Shows the chevron of the draft menu. */
  menu?: boolean;
  /** A phone's chip: taller and larger type than the identity bar's 22px box. */
  touch?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-1.5 font-medium font-sans text-xs transition-colors",
        touch ? "h-8 px-2.5 text-sm" : IDENTITY_BAR_BOX_CLASS,
        TONE[state],
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          state === "failed" ? "bg-destructive" : "bg-primary",
        )}
      />
      {children}
      {menu ? <ChevronDown aria-hidden className="-mr-0.5 size-3 shrink-0 opacity-70" /> : null}
    </span>
  );
}
