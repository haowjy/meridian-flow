import type { ReactNode } from "react";
import { Chip } from "@/components/ui/chip";
import { ChooserMark } from "@/components/ui/marks";
import { cn } from "@/lib/utils";

type DraftChipState = "live" | "pending" | "reviewing" | "failed";

const TONE = {
  live: "neutral",
  pending: "neutral",
  reviewing: "jade",
  failed: "destructive",
} as const satisfies Record<DraftChipState, string>;

const NEUTRAL_RESPONSE =
  "group-hover/chip:bg-ink-fill group-hover/chip:text-foreground group-popup-open/chip:bg-ink-fill-strong group-popup-open/chip:text-foreground";

const RESPONSE: Record<DraftChipState, string> = {
  live: NEUTRAL_RESPONSE,
  pending: NEUTRAL_RESPONSE,
  reviewing: "group-hover/chip:bg-primary/22 group-popup-open/chip:bg-primary/22",
  failed: "",
};

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
  menu?: boolean;
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
