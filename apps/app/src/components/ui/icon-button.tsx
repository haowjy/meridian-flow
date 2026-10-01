/**
 * IconButton — the canonical icon-only button.
 *
 * A thin wrapper over `Button` (not a parallel implementation) so icon-only
 * affordances share Button's focus/disabled/`asChild`/svg-sizing contract and
 * stop hand-rolling `grid size-N place-items-center …` with drifting size
 * (6/7/8), radius, tone, and hover. This mirrors how mature systems expose a
 * named icon button (shadcn = `Button size="icon"`; Chakra/Primer = a wrapper
 * over the shared Button base).
 *
 * Defaults to the `quiet` chrome tone (muted, rail-accent hover). `size` maps to
 * Button's square icon sizes — the drifting size-7 sites collapse onto `sm`.
 * Name it with `tooltip` (the label on hover and focus, and the aria-label), or
 * with an `aria-label` alone when a tooltip would crowd the surface. The
 * tooltip's trigger is the button itself, so the whole square answers; a
 * popover or menu trigger wraps this component (`asChild`), never the icon.
 */
import type * as React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const SIZE_TO_BUTTON = {
  xs: "icon-xs", // size-6 — dense in-row actions
  sm: "icon-sm", // size-8 — panel toggles, menu triggers
  md: "icon", // size-9 — standalone controls
} as const;

type ButtonProps = React.ComponentProps<typeof Button>;

export type IconButtonProps = Omit<ButtonProps, "size"> & {
  size?: keyof typeof SIZE_TO_BUTTON;
  /** The button's name, shown in a tooltip on hover and focus. */
  tooltip?: string;
  tooltipSide?: React.ComponentProps<typeof TooltipContent>["side"];
};

export function IconButton({
  size = "xs",
  variant = "quiet",
  tooltip,
  tooltipSide,
  ...props
}: IconButtonProps) {
  const button = (
    <Button
      data-slot="icon-button"
      variant={variant}
      size={SIZE_TO_BUTTON[size]}
      aria-label={tooltip}
      {...props}
    />
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side={tooltipSide}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
