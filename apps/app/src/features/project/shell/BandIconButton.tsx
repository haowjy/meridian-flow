import type { ComponentProps, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { tabChipClass } from "./tab-chip";

/**
 * An icon-only control in a `tab-band` (Recently opened, New, All open tabs): a tab chip, so its
 * hover pill, height and glyph match the tabs beside it under any pointer. `label` names it and
 * is its tooltip unless `tooltip` says more.
 */
export function BandIconButton({
  label,
  tooltip = label,
  active = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"button">, "aria-label"> & {
  label: string;
  tooltip?: ReactNode;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className={cn("focus-ring shrink-0 [&_svg]:size-3.5", tabChipClass(active), className)}
          {...props}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}
