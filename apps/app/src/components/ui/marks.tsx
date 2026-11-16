import { ChevronRight, ChevronsUpDown } from "lucide-react";
import type { ComponentProps } from "react";
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

/**
 * Small muted words beside a label (a shortcut, Default, Archived), on the label's baseline in a
 * row that centres its items. Pass `className` only for layout.
 */
export function LabelNote({ className, children, ...props }: ComponentProps<"span">) {
  return (
    // The outer span keeps the label's text size, so the row centres it like the label, and the
    // smaller words inside sit on its baseline. A text-xs box centred on its own sits higher.
    <span className={cn(role.secondary, className)} {...props}>
      <span className="text-xs">{children}</span>
    </span>
  );
}
