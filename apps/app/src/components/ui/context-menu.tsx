/** Context activation with the shared menu presentation and keyboard equivalent. */
import { ContextMenu as Primitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import {
  dropdownMenuContentClass,
  dropdownMenuItemClass,
  dropdownNavigationPageClass,
  dropdownRowVariants,
} from "./dropdown-presentation";

export const ContextMenu = Primitive.Root;

export function ContextMenuTrigger({
  onKeyDown,
  ...props
}: ComponentProps<typeof Primitive.Trigger>) {
  return (
    <Primitive.Trigger
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          event.currentTarget.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: rect.left,
              clientY: rect.bottom,
            }),
          );
        }
      }}
    />
  );
}

export function ContextMenuContent({
  className,
  onPointerUpCapture,
  ...props
}: ComponentProps<typeof Primitive.Content>) {
  return (
    <Primitive.Portal>
      <Primitive.Content
        {...props}
        onPointerUpCapture={(event) => {
          onPointerUpCapture?.(event);
          // The release that summoned a context menu must not select its first row.
          if (event.button !== 0) event.preventDefault();
        }}
        className={cn(
          dropdownNavigationPageClass,
          dropdownMenuContentClass,
          "[--radix-menu-content-available-height:var(--radix-context-menu-content-available-height)]",
          className,
        )}
      />
    </Primitive.Portal>
  );
}

export function ContextMenuItem({ className, ...props }: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      {...props}
      className={cn(dropdownRowVariants(), dropdownMenuItemClass, className)}
    />
  );
}

export function ContextMenuLabel({ className, ...props }: ComponentProps<typeof Primitive.Label>) {
  return (
    <Primitive.Label {...props} className={cn("px-2 py-1.5 text-sm font-medium", className)} />
  );
}
