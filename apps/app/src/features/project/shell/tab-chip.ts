/**
 * The one place a chip in a `tab-band` gets its shape: the document tabs, the
 * band's index door and return tab, and the chat and Work title tabs. A site
 * adds only what is its own: its width, its gaps, its focus ring.
 *
 * The geometry itself (the folder tab's outline, the hover pill, the band's
 * gutter and height) is the tab-chip grammar in `styles/globals.css`. The page a
 * band's chips sit over takes its place here too (`pageSheetClass`).
 */
import { cn } from "@/lib/utils";

/**
 * `active` is the folder tab the page rises into; otherwise the chip is an
 * inactive tab with a hover pill. Both fill the band's height, so an active
 * chip's base sits on the band's bottom edge where the page begins. An
 * inactive chip dims; content that sets its own colour (a title) is unaffected.
 */
export function tabChipClass(active: boolean) {
  return cn(
    "relative flex items-center self-stretch px-3",
    active
      ? "tab-chip-active text-foreground"
      : "tab-chip-inactive text-muted-foreground hover:text-foreground",
  );
}

/**
 * The pane band's title chip, shared by the switcher trigger and the in-tab
 * rename so renaming keeps the chip and its text exactly where they were.
 * `tab`: the page's own title. `quiet`: a title where no page rises (the
 * side panel, the phone's top bar), which keeps only the hover pill.
 */
export function titleChipClass(variant: "quiet" | "tab") {
  return cn(
    "w-fit min-w-0 max-w-full gap-[var(--chat-space-inline)]",
    tabChipClass(variant === "tab"),
    // Pairs with the band's 14px gutter (`tab-band`) and the pill's 2px inset: the side
    // picker's hover pill starts 8px in, on the side page's edge (`pageSheetClass`).
    variant === "quiet" && "-ml-2 coarse:min-h-11",
  );
}

/**
 * The page under a pane's band. The side's is inset 8px from main's, the gap the quiet
 * title chip's pill lines up with.
 */
export function pageSheetClass(side: boolean) {
  return cn("page-sheet", side && "ml-2");
}
