/** Shared hit-area and row geometry for visible context-tree overflow controls. */
import { cn } from "@/lib/utils";

export const contextTreeRowClassName =
  "h-8 [@media(hover:none)]:h-11 [@media(pointer:coarse)]:h-11";

/** A browsing row may grow past its resting height when it carries a second line. */
export const contextTreeRowGrowClassName =
  "min-h-8 [@media(hover:none)]:min-h-11 [@media(pointer:coarse)]:min-h-11";

/**
 * A file row's frame: the tree's own rows, the right rail's Recent rows and the
 * left rail's Scratch rows wear it, so height, padding, text and the hover and selected
 * fills cannot drift apart. Hover is inactive-only: the active row keeps its
 * stronger fill.
 */
export function contextTreeFileRowClassName(active: boolean): string {
  return cn(
    "group mx-2 flex items-center rounded-md pr-1 text-sm",
    contextTreeRowGrowClassName,
    active
      ? "bg-sidebar-accent font-medium text-foreground"
      : "text-foreground hover:bg-sidebar-accent/50",
  );
}

export const contextTreeOverflowTriggerClassName =
  "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100";

export const mobileContextTreeOverflowTriggerClassName = "size-11 opacity-100";
