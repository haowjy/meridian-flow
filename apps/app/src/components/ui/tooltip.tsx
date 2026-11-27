"use client";

import { Tooltip as TooltipPrimitive } from "radix-ui";
import type * as React from "react";
import { createContext, useContext } from "react";

import { lastInputWasKeyboard } from "@/lib/focus-follow";
import { cn } from "@/lib/utils";

function TooltipProvider({
  delayDuration = 0,
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

const HoverableContext = createContext(false);

function Tooltip({
  hoverable = false,
  ...props
}: Omit<React.ComponentProps<typeof TooltipPrimitive.Root>, "disableHoverableContent"> & {
  hoverable?: boolean;
}) {
  return (
    <HoverableContext.Provider value={hoverable}>
      <TooltipPrimitive.Root data-slot="tooltip" disableHoverableContent={!hoverable} {...props} />
    </HoverableContext.Provider>
  );
}

function preventWhilePopupOpen(event: React.SyntheticEvent<HTMLButtonElement>) {
  const trigger = event.currentTarget;
  const popup = trigger.getAttribute("aria-haspopup");
  if (popup === null || popup === "false") return;
  if (trigger.getAttribute("aria-expanded") === "true") event.preventDefault();
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
        preventWhilePopupOpen(event);
      }}
      onFocus={(event) => {
        onFocus?.(event);
        preventWhilePopupOpen(event);
        if (!lastInputWasKeyboard()) event.preventDefault();
      }}
      {...props}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 4,
  children,
  onEscapeKeyDown,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const hoverable = useContext(HoverableContext);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        // Radix gives Escape to the topmost layer only; re-dispatch it after the tooltip closes
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          if (event.defaultPrevented) return;
          const target = event.target;
          setTimeout(() => {
            target?.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
            );
          });
        }}
        className={cn(
          !hoverable && "pointer-events-none",
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-sm bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
