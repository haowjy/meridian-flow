/**
 * The toolbar's one button style, and the greying it does instead of
 * disabling.
 *
 * A `disabled` button leaves the hover and focus path, so the writer never
 * learns why it will not apply. A toolbar control that cannot run here stays
 * reachable, wears `aria-disabled`, drops its action, and carries the reason in
 * its tooltip (law 5: never absent, never dead). Controls that open a surface
 * compose their trigger around `ToolbarControlTooltip` and the shared class so
 * the whole row keeps one visual language.
 */
import type { ComponentProps, ReactNode } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type ToolbarButtonProps = Omit<
  ComponentProps<typeof IconButton>,
  "variant" | "size" | "aria-label" | "aria-pressed" | "aria-disabled"
> & {
  label: string;
  /** Writer-facing reason the control cannot apply; greys it when present. */
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
    active && "bg-primary/10 text-primary hover:text-primary",
    blocked &&
      "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-current active:scale-100",
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
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-56">
        <span className="block">{label}</span>
        {blockedReason ? <span className="block text-background/70">{blockedReason}</span> : null}
      </TooltipContent>
    </Tooltip>
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
    <ToolbarControlTooltip label={label} blockedReason={blockedReason}>
      <IconButton
        {...rest}
        type="button"
        variant="ghost"
        size="xs"
        aria-label={label}
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
    </ToolbarControlTooltip>
  );
}
