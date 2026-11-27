import { cn } from "@/lib/utils";

export function tabChipClass(active: boolean) {
  return cn(
    "relative flex items-center self-stretch px-3",
    active
      ? "tab-chip-active text-foreground"
      : "tab-chip-inactive text-muted-foreground hover:text-foreground",
  );
}

export function titleChipClass(variant: "quiet" | "tab") {
  return cn(
    "w-fit min-w-0 max-w-full gap-[var(--chat-space-inline)]",
    tabChipClass(variant === "tab"),
    // Pairs with the band's 14px gutter (`tab-band`) and the pill's 2px inset: the side
    // picker's hover pill starts 8px in, on the side page's edge (`pageSheetClass`).
    variant === "quiet" && "-ml-2 coarse:min-h-11",
  );
}

export function pageSheetClass(side: boolean) {
  return cn("page-sheet", side && "ml-2");
}
