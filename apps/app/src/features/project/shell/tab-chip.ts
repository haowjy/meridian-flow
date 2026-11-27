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
    variant === "quiet" && "-ml-2 coarse:min-h-11",
  );
}

export function pageSheetClass(side: boolean) {
  return cn("page-sheet", side && "ml-2");
}
