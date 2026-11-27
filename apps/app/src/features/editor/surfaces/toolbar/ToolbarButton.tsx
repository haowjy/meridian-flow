import type { ComponentProps, ReactNode } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
// Straight at the primitive: the chrome barrel also carries the surface
// registry this lane is listed in, and the round trip is a module cycle.
import { ReasonLines, ReasonTooltip } from "../../chrome/ReasonTooltip";

export type ToolbarButtonProps = Omit<
  ComponentProps<typeof IconButton>,
  "variant" | "size" | "label" | "tooltip" | "aria-pressed" | "aria-disabled"
> & {
  label: string;
  blockedReason?: string | null;
  active?: boolean;
  onPress?: () => void;
  children: ReactNode;
};

export function toolbarControlClass({
  active = false,
  blocked = false,
}: {
  active?: boolean;
  blocked?: boolean;
}): string {
  return cn(
    active && "text-foreground hover:text-foreground",
    blocked && "cursor-not-allowed opacity-50 hover:text-current active:scale-100",
  );
}

export function ToolbarControlTooltip({
  label,
  blockedReason,
  children,
}: {
  label: string;
  blockedReason?: string | null;
  children: ReactNode;
}) {
  return (
    <ReasonTooltip name={label} reason={blockedReason} side="bottom">
      {children}
    </ReasonTooltip>
  );
}

export function ToolbarButton({
  label,
  blockedReason,
  active = false,
  onPress,
  onClick,
  className,
  children,
  ...rest
}: ToolbarButtonProps) {
  const blocked = Boolean(blockedReason);

  return (
    <IconButton
      {...rest}
      type="button"
      variant="ghost"
      size="xs"
      label={label}
      tooltip={<ReasonLines name={label} reason={blockedReason} />}
      tooltipSide="bottom"
      tooltipContentProps={{ className: "max-w-56" }}
      aria-pressed={active || undefined}
      aria-disabled={blocked || undefined}
      className={cn(toolbarControlClass({ active, blocked }), className)}
      onClick={(event) => {
        if (blocked) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
        onPress?.();
      }}
    >
      {children}
    </IconButton>
  );
}
