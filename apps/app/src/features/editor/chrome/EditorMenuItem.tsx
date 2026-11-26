import type { ComponentProps } from "react";

import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { ReasonTooltip } from "./ReasonTooltip";

type Refusable = { blockedReason?: string | null };

export type EditorMenuItemProps = ComponentProps<typeof DropdownMenuItem> & Refusable;
export type EditorMenuCheckboxItemProps = ComponentProps<typeof DropdownMenuCheckboxItem> &
  Refusable;

const REFUSED_ROW = "cursor-not-allowed opacity-50";

type RowProps = { className?: string; onSelect?: (event: Event) => void };

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
