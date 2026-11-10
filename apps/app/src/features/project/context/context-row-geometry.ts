/** Shared row geometry and the sidebar's icon sizes. Looks come from `role`. */
import { role } from "@/components/ui/roles";
import { cn } from "@/lib/utils";

/** One icon size per role. */
export const sidebarIcon = {
  tab: "size-4",
  row: "size-3.5",
  action: "size-4",
} as const;

export const contextTreeRowClassName = "h-7 [@media(hover:none)]:h-11 coarse:h-11";

/** A browsing row may grow past its resting height when it carries a second line. */
export const contextTreeRowGrowClassName = "min-h-7 [@media(hover:none)]:min-h-11 coarse:min-h-11";

// Adjacent selected rows join into one block, rounded only at the run's ends
// (`data-selection-run`, set by the list's selection).
const selectionRunShape =
  "data-[selection-run=start]:rounded-b-none data-[selection-run=middle]:rounded-none data-[selection-run=end]:rounded-t-none";

/** A row in an explicit selection; the open row tells itself apart by its weight. */
export const contextTreeSelectedRowClassName = cn(role.selected, selectionRunShape);

/**
 * A row's frame: tree rows, Trash rows, chat rows and the right rail's Recent
 * rows wear it, so height, padding, text and the hover and selected fills
 * cannot drift apart. Hover is inactive-only: the active row keeps its fill.
 */
export function contextTreeFileRowClassName(active: boolean, selected = false): string {
  return cn(
    "group mx-2 flex items-center rounded-md pr-1 text-foreground",
    role.row,
    contextTreeRowGrowClassName,
    active && "font-medium",
    active || selected ? contextTreeSelectedRowClassName : role.hover,
  );
}

export const contextTreeOverflowTriggerClassName =
  "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100 coarse:size-11 coarse:opacity-100";
