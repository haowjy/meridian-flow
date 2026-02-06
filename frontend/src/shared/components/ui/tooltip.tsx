import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

/**
 * TooltipProvider wraps a section of your app to control tooltip delay behavior.
 * Can be placed at app root or around specific sections.
 *
 * @param delayDuration - ms before tooltip opens (default: 300)
 * @param skipDelayDuration - ms to skip delay when moving between tooltips (default: 150)
 */
function TooltipProvider({
  delayDuration = 300,
  skipDelayDuration = 150,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          // Base styles
          "z-50 overflow-hidden rounded px-2 py-1",
          // Colors - dark background, light text (inverted from popover)
          "bg-foreground text-background",
          // Typography
          "text-xs",
          // Animation
          "animate-in fade-in-0 zoom-in-95",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          // Slide direction based on placement
          "data-[side=bottom]:slide-in-from-top-2",
          "data-[side=left]:slide-in-from-right-2",
          "data-[side=right]:slide-in-from-left-2",
          "data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}

/**
 * SimpleTooltip - Convenience wrapper for the common tooltip pattern.
 * Wraps a single child element with a tooltip.
 *
 * @example
 * <SimpleTooltip content="This is a tooltip">
 *   <Button>Hover me</Button>
 * </SimpleTooltip>
 *
 * @example
 * // With custom side
 * <SimpleTooltip content="Opens settings" side="right">
 *   <Settings className="size-4" />
 * </SimpleTooltip>
 */
interface SimpleTooltipProps {
  /** The tooltip text or React node */
  content: React.ReactNode;
  /** Which side the tooltip appears on */
  side?: "top" | "right" | "bottom" | "left";
  /** The element that triggers the tooltip */
  children: React.ReactNode;
  /** Additional className for TooltipContent */
  className?: string;
  /** Whether to use asChild on trigger (default: true for icon-only elements) */
  asChild?: boolean;
}

function SimpleTooltip({
  content,
  side = "top",
  children,
  className,
  asChild = true,
}: SimpleTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild={asChild}>{children}</TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

export {
  TooltipProvider,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  SimpleTooltip,
};
