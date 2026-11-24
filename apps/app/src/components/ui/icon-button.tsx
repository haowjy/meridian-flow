import type * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const SIZE_TO_BUTTON = {
  xs: "icon-xs",
  sm: "icon-sm",
} as const;

type ButtonProps = React.ComponentProps<typeof Button>;
type TooltipContentProps = React.ComponentProps<typeof TooltipContent>;

export type IconButtonProps = Omit<ButtonProps, "size" | "aria-label"> & {
  size?: keyof typeof SIZE_TO_BUTTON;
  label: string;
  tooltip?: React.ReactNode;
  tooltipSide?: TooltipContentProps["side"];
  tooltipContentProps?: Omit<TooltipContentProps, "side" | "children">;
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
