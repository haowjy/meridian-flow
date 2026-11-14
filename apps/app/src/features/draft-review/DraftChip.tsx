/**
 * DraftChip — the version chip of a document, in its states, the same state as the sidebar's
 * Live/Draft toggle. Live: a document no Work has drafted. Pending: "Live", neutral like the
 * toggle on Live, with a small jade dot for the draft that waits. Reviewing: "Draft", jade like
 * the toggle on Draft. Each is the trigger of the same version menu (`DraftSwitcher`), in the same
 * box, so the control the writer clicked to get in is still where they look to get out.
 *
 * Presentational: `DraftChipFace` is the pill; the caller wraps it in the
 * button or menu trigger that owns the click, focus ring and hit area (the
 * wrapper carries `group/chip` so the face can answer hover and open).
 */
import type { ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { ChooserMark } from "@/components/ui/marks";
import { cn } from "@/lib/utils";

export type DraftChipState = "live" | "pending" | "reviewing" | "failed";

const TONE = {
  live: "neutral",
  pending: "neutral",
  reviewing: "jade",
  failed: "destructive",
} as const satisfies Record<DraftChipState, string>;

const NEUTRAL_RESPONSE =
  "group-hover/chip:bg-ink-fill group-hover/chip:text-foreground group-popup-open/chip:bg-ink-fill-strong group-popup-open/chip:text-foreground";

/** The chip answers its wrapper's hover and open menu. */
const RESPONSE: Record<DraftChipState, string> = {
  live: NEUTRAL_RESPONSE,
  pending: NEUTRAL_RESPONSE,
  reviewing: "group-hover/chip:bg-primary/22 group-popup-open/chip:bg-primary/22",
  failed: "",
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
    <Chip tone={TONE[state]} className={cn(RESPONSE[state], touch && "h-8 px-2.5 text-sm")}>
      {state === "live" ? null : (
        <span
          aria-hidden
          className={cn(
            "size-1.5 rounded-full",
            state === "failed" ? "bg-destructive" : "bg-primary",
          )}
        />
      )}
      <span>{children}</span>
      {menu ? <ChooserMark className="-mr-0.5" /> : null}
    </Chip>
  );
}
