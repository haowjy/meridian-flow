/** Shared hit-area and row geometry for visible context-tree overflow controls. */
import { cn } from "@/lib/utils";

export const contextTreeRowClassName =
  "h-8 [@media(hover:none)]:h-11 [@media(pointer:coarse)]:h-11";

/** A browsing row may grow past its resting height when it carries a second line. */
export const contextTreeRowGrowClassName =
  "min-h-8 [@media(hover:none)]:min-h-11 [@media(pointer:coarse)]:min-h-11";

// Adjacent selected rows join into one block, rounded only at the run's ends
// (`data-selection-run`, set by the list's selection).
const selectionRunShape =
  "data-[selection-run=start]:rounded-b-none data-[selection-run=middle]:rounded-none data-[selection-run=end]:rounded-t-none";

/** A row in an explicit selection: its own fill, apart from hover and from the open row's. */
export const contextTreeSelectedRowClassName = cn("bg-sidebar-selected", selectionRunShape);

/**
 * A file row's frame: the tree's own rows, the right rail's Recent rows and the
 * left rail's Scratch rows wear it, so height, padding, text and the hover and selected
 * fills cannot drift apart. Hover is inactive-only: the active row keeps its
 * stronger fill.
 */
export function contextTreeFileRowClassName(active: boolean, selected = false): string {
  return cn(
    "group mx-2 flex items-center rounded-md pr-1 text-sm text-foreground",
    contextTreeRowGrowClassName,
    active && "font-medium",
    active
      ? cn("bg-sidebar-accent", selected && selectionRunShape)
      : selected
        ? contextTreeSelectedRowClassName
        : "hover:bg-sidebar-accent/50",
  );
}

export const contextTreeOverflowTriggerClassName =
  "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100";

/** The lit target of a drag: an area header, or a folder with everything shown inside it. */
export const contextTreeDropTargetClassName =
  "bg-sidebar-accent ring-1 ring-border-focus ring-inset";
