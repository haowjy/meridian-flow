/**
 * IconButton — the one icon-only button.
 *
 * A wrapper over `Button`, so icon-only controls share its focus, disabled, `asChild`
 * and svg sizing. `label` is required: it is the accessible name and the tooltip, so an
 * icon never ships unnamed or named only by the native `title`. Under a coarse pointer
 * the square grows to the 44px touch target (from `Button`'s icon sizes), so callers
 * never add touch sizing. A `dense` button sits where its row can't grow: it keeps its
 * box and a centred 44px hit area extends past it.
 *
 * The tooltip's trigger is the button itself, so the whole square answers; a popover
 * or menu trigger wraps this component (`asChild`), never the icon.
 */
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SIZE_TO_BUTTON = {
  xs: "icon-xs", // size-6, 14px glyph: in-row and heading actions
  sm: "icon-sm", // size-8, 16px glyph: panel toggles, menu triggers, standalone controls
} as const;

type ButtonProps = React.ComponentProps<typeof Button>;
type TooltipContentProps = React.ComponentProps<typeof TooltipContent>;

export type IconButtonProps = Omit<ButtonProps, "size" | "aria-label"> & {
  size?: keyof typeof SIZE_TO_BUTTON;
  /** The button's name: its aria-label and its tooltip. */
  label: string;
  /** Tooltip content when it says more than the name, e.g. why the control can't run. */
  tooltip?: React.ReactNode;
  tooltipSide?: TooltipContentProps["side"];
  /** Attributes for the portalled tooltip, for chrome that must read it as its own. */
  tooltipContentProps?: Omit<TooltipContentProps, "side" | "children">;
  /** Keeps its box under a finger; the 44px hit area extends past it instead. */
  dense?: boolean;
};

const DENSE_HIT_AREA =
  "relative coarse:after:absolute coarse:after:top-1/2 coarse:after:left-1/2 coarse:after:size-11 coarse:after:-translate-1/2 coarse:after:content-['']";

export function IconButton({
  size = "xs",
  variant = "quiet",
  label,
  tooltip = label,
  tooltipSide,
  tooltipContentProps,
  dense = false,
  className,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          data-slot="icon-button"
          variant={variant}
          size={SIZE_TO_BUTTON[size]}
          aria-label={label}
          data-touch={dense ? "dense" : undefined}
          className={cn(dense && DENSE_HIT_AREA, className)}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side={tooltipSide} {...tooltipContentProps}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
