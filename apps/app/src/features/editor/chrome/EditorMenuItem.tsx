/**
 * The menu row every editor surface renders, and the one place a refusal is
 * drawn.
 *
 * A row that cannot run here greys, keeps its hover and focus, drops its
 * action, and shows its LABEL ALONE; the reason arrives in a tooltip when the
 * writer reaches the row (law 5, ruling 2026-07-29). Radix's `disabled` would
 * take the row out of the hover and focus path and the reason with it, so
 * nothing here uses it — `aria-disabled` says the same thing to a screen
 * reader and leaves the row reachable.
 *
 * Passing `blockedReason` is the whole contract: a lane never wires the
 * greying, the swallowed select, or the tooltip itself.
 */
import type { ComponentProps } from "react";

import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ReasonTooltip } from "./ReasonTooltip";

/** Why this row cannot run here. Null or absent means it runs. */
type Refusable = { blockedReason?: string | null };

export type EditorMenuItemProps = ComponentProps<typeof DropdownMenuItem> & Refusable;
export type EditorMenuCheckboxItemProps = ComponentProps<typeof DropdownMenuCheckboxItem> &
  Refusable;

/**
 * Greyed, and still the row the writer is on: the highlight stays, so arrowing
 * onto a refused row shows where they are, muted by the same opacity as the
 * rest of it.
 */
const REFUSED_ROW = "cursor-not-allowed opacity-50";

type RowProps = { className?: string; onSelect?: (event: Event) => void };

/** What a reason does to a row, for whichever Radix item is wearing it. */
function refusal(blockedReason: string | null | undefined, { className, onSelect }: RowProps) {
  if (!blockedReason) return { className, onSelect };
  return {
    "aria-disabled": true,
    className: cn(REFUSED_ROW, className),
    // The menu stays open on a refused select: the writer came for the reason,
    // and closing would take it away on the frame they asked for it.
    onSelect: (event: Event) => event.preventDefault(),
  };
}

export function EditorMenuItem({
  blockedReason,
  className,
  onSelect,
  ...props
}: EditorMenuItemProps) {
  return (
    <ReasonTooltip name={props["aria-label"]} reason={blockedReason}>
      <DropdownMenuItem {...props} {...refusal(blockedReason, { className, onSelect })} />
    </ReasonTooltip>
  );
}

export function EditorMenuCheckboxItem({
  blockedReason,
  className,
  onSelect,
  ...props
}: EditorMenuCheckboxItemProps) {
  return (
    <ReasonTooltip name={props["aria-label"]} reason={blockedReason}>
      <DropdownMenuCheckboxItem {...props} {...refusal(blockedReason, { className, onSelect })} />
    </ReasonTooltip>
  );
}
