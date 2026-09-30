/** The pane band's title chip shell, shared by chat and Work title tabs. */
import { cn } from "@/lib/utils";

/**
 * Shared by the switcher trigger and the in-tab rename so renaming keeps the
 * chip and its text exactly where they were. `tab`: h-9 plus the grammar's top
 * margin exactly fill the h-10 band, so the chip's base (and its flares) sit on
 * the band's bottom edge where the page begins. `quiet`: an inactive document
 * tab's hover, the inset pill over the band's full height.
 */
export function titleChipClass(variant: "quiet" | "tab") {
  return cn(
    "flex w-fit min-w-0 max-w-full items-center gap-[var(--chat-space-inline)]",
    variant === "tab"
      ? "tab-chip-active relative h-9 px-[var(--chat-card-pad-x)] [--tab-chip-surface:var(--color-background)]"
      : "tab-chip-inactive relative -ml-2 self-stretch px-[var(--chat-card-pad-x)] [--tab-chip-surface:var(--color-background)] [@media(pointer:coarse)]:min-h-11",
  );
}
