"use client";

/**
 * Tooltip — shadcn/Radix tooltip primitive (provider, trigger, content).
 * Upstream-managed wrapper; customize via `cn()` + tokens at call sites.
 *
 * Meridian's tooltips are labels, never surfaces: content cannot be hovered or
 * hit, so moving between adjacent triggers swaps tooltips at once, and a
 * trigger whose own popover or menu is open does not reopen its tooltip.
 *
 * Content has no exit animation. Radix keeps closing content mounted while it
 * animates out, and that fading copy still hears the "a tooltip opened" event,
 * so a trigger re-entered mid-fade would close its own fresh tooltip. Closing
 * instantly also leaves no stale label beside the new one.
 */
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 0,
  // Radix's hoverable content keeps a tooltip open while the pointer crosses a
  // hull from the trigger to the content. A label wider than its icon button
  // hangs over the neighbours, so that hull covers them: their tooltips stay
  // blocked and the old one stays up until the pointer leaves the hull.
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

/**
 * While the trigger's own popover or menu is open it is the answer, and its
 * tooltip would sit on top of it. Radix skips its open handler for an event
 * already default-prevented.
 */
function preventWhileExpanded(event: React.SyntheticEvent<HTMLButtonElement>) {
  if (event.currentTarget.getAttribute("aria-expanded") === "true") event.preventDefault();
}

function TooltipTrigger({
  onPointerMove,
  onFocus,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      onPointerMove={(event) => {
        onPointerMove?.(event);
        preventWhileExpanded(event);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        preventWhileExpanded(event);
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  // A small gap so the label never touches, or reads as part of, its trigger.
  sideOffset = 4,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "pointer-events-none z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
