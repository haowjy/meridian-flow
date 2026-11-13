/** Context activation with the shared menu presentation and keyboard equivalent. */

import { ChevronRight } from "lucide-react";
import { ContextMenu as Primitive } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import {
  dropdownGroupLabelClass,
  dropdownMenuContentClass,
  dropdownMenuItemClass,
  dropdownMenuSeparatorClass,
  dropdownPageClass,
  dropdownRowVariants,
} from "./dropdown-presentation";

export const ContextMenu = Primitive.Root;
export const ContextMenuSub = Primitive.Sub;

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
          dropdownPageClass,
          dropdownMenuContentClass,
          "origin-(--radix-context-menu-content-transform-origin) [--radix-menu-content-available-height:var(--radix-context-menu-content-available-height)]",
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
  return <Primitive.Label {...props} className={cn(dropdownGroupLabelClass, className)} />;
}

export function ContextMenuSeparator(props: ComponentProps<typeof Primitive.Separator>) {
  return <Primitive.Separator {...props} className={dropdownMenuSeparatorClass} />;
}

export function ContextMenuSubTrigger({
  children,
  ...props
}: ComponentProps<typeof Primitive.SubTrigger>) {
  return (
    <Primitive.SubTrigger
      {...props}
      className={cn(
        dropdownRowVariants(),
        dropdownMenuItemClass,
        "data-[state=open]:bg-ink-fill-strong",
      )}
    >
      {children}
      <ChevronRight aria-hidden className="ml-auto size-3.5" />
    </Primitive.SubTrigger>
  );
}

export function ContextMenuSubContent(props: ComponentProps<typeof Primitive.SubContent>) {
  return (
    <Primitive.Portal>
      <Primitive.SubContent
        {...props}
        className={cn(
          dropdownPageClass,
          dropdownMenuContentClass,
          "origin-(--radix-context-menu-content-transform-origin)",
        )}
      />
    </Primitive.Portal>
  );
}
