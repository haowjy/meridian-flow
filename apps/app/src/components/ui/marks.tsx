import { ChevronRight, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { role } from "./roles";

/** The open/closed mark on anything that folds: points right, turns down when open. Pass `className` only for layout. */
export function DisclosureMark({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      aria-hidden
      className={cn(
        "size-3 shrink-0 transition-transform motion-reduce:transition-none",
        role.secondary,
        open && "rotate-90",
        className,
      )}
    />
  );
}

/** The mark on a control that opens a choice of values. Pass `className` only for layout. */
export function ChooserMark({ className }: { className?: string }) {
  return (
    <ChevronsUpDown aria-hidden className={cn("size-3 shrink-0", role.secondary, className)} />
  );
}
