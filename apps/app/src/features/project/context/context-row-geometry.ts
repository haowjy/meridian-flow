/** Shared row geometry and the sidebar's named looks. */
import { cn } from "@/lib/utils";

/**
 * Every text size, secondary colour and fill in the sidebar comes from one of
 * these roles, so re-pointing a role restyles the whole sidebar at once.
 */
export const sidebarRole = {
  /** A row's name, and controls that read as rows. Colour is the inherited foreground. */
  row: "text-sm",
  /** The secondary colour: row icons, facts beside a name, controls at rest. */
  secondary: "text-ink-muted",
  /** Facts beside or under a row's name: age, former place, counts; group labels. */
  rowSecondary: "text-xs text-ink-muted",
  /** A list's name above its rows. */
  heading: "text-xs font-medium uppercase tracking-wide text-ink-muted",
  /** Lines standing in for rows: loading, empty. */
  hint: "text-xs text-ink-subtle",
  hover: "hover:bg-sidebar-accent/50",
  /** The open row, the shown tab, the current chat, rows in a selection. Ink, never jade. */
  selected: "bg-sidebar-accent",
  /** A control whose menu is open wears the selected fill. */
  open: "popup-open:bg-sidebar-accent popup-open:text-foreground",
  /** A drag's lit target: a tab, a source, a folder with everything shown inside it. */
  dropTarget: "bg-sidebar-accent ring-1 ring-border-focus ring-inset",
} as const;

/** One icon size per role. */
export const sidebarIcon = {
  tab: "size-4",
  row: "size-3.5",
  action: "size-4",
} as const;

export const contextTreeRowClassName =
  "h-7 [@media(hover:none)]:h-11 [@media(pointer:coarse)]:h-11";

/** A browsing row may grow past its resting height when it carries a second line. */
export const contextTreeRowGrowClassName =
  "min-h-7 [@media(hover:none)]:min-h-11 [@media(pointer:coarse)]:min-h-11";

// Adjacent selected rows join into one block, rounded only at the run's ends
// (`data-selection-run`, set by the list's selection).
const selectionRunShape =
  "data-[selection-run=start]:rounded-b-none data-[selection-run=middle]:rounded-none data-[selection-run=end]:rounded-t-none";

/** A row in an explicit selection; the open row tells itself apart by its weight. */
export const contextTreeSelectedRowClassName = cn(sidebarRole.selected, selectionRunShape);

/**
 * A row's frame: tree rows, Trash rows, chat rows and the right rail's Recent
 * rows wear it, so height, padding, text and the hover and selected fills
 * cannot drift apart. Hover is inactive-only: the active row keeps its fill.
 */
export function contextTreeFileRowClassName(active: boolean, selected = false): string {
  return cn(
    "group mx-2 flex items-center rounded-md pr-1 text-foreground",
    sidebarRole.row,
    contextTreeRowGrowClassName,
    active && "font-medium",
    active || selected ? contextTreeSelectedRowClassName : sidebarRole.hover,
  );
}

export const contextTreeOverflowTriggerClassName =
  "opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:size-11 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100";
