/**
 * The one place a chip in a `tab-band` gets its shape: the document tabs, the
 * band's index door and return tab, and the chat and Work title tabs. A site
 * adds only what is its own: its width, its gaps, its focus ring.
 *
 * The geometry itself (the folder tab's outline, the hover pill, the band's
 * gutter) is the tab-chip grammar in `styles/globals.css`.
 */
import { cn } from "@/lib/utils";

/**
 * `active` is the folder tab the page rises into; otherwise the chip is an
 * inactive tab with a hover pill. Both fill the band's height, so an active
 * chip's base sits on the band's bottom edge where the page begins.
 *
 * `tone`: a `tab` dims while inactive; a `title` leaves colour to its text.
 */
export function tabChipClass(active: boolean, tone: "tab" | "title" = "tab") {
  return cn(
    "relative flex items-center self-stretch px-3",
    active ? "tab-chip-active" : "tab-chip-inactive",
    tone === "tab" && (active ? "text-foreground" : "text-muted-foreground hover:text-foreground"),
  );
}

/**
 * The pane band's title chip, shared by the switcher trigger and the in-tab
 * rename so renaming keeps the chip and its text exactly where they were.
 * `tab`: the page's own title. `quiet`: a title where no page rises (the
 * side panel), which keeps only the hover pill.
 */
export function titleChipClass(variant: "quiet" | "tab") {
  return cn(
    "w-fit min-w-0 max-w-full gap-[var(--chat-space-inline)]",
    tabChipClass(variant === "tab", "title"),
    variant === "quiet" && "-ml-2 coarse:min-h-11",
  );
}
