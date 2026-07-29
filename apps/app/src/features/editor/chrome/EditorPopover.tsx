/**
 * EditorPopover — the editor's anchored form surface (link editing, alt text).
 *
 * Same subordination contract as `EditorMenu`: it registers as a layer so the
 * Esc chain knows about it, and closing hands the caret back to the prose.
 *
 * The difference is where focus goes on the way IN. A popover holds a form, so
 * Radix's opening focus is correct and stays: the writer opened it to type.
 * And on the way out it ignores focus alone: see `onFocusOutside` below.
 */

import type { Editor } from "@tiptap/core";
import type { ComponentProps, ReactNode } from "react";

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useChromeLayer } from "./chrome-layers";
import { pointerAnchorStyle } from "./pointer-anchor";

export type EditorPopoverProps = {
  editor: Editor | null;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Client coordinates, for a popover anchored to a place rather than a control. */
  at?: { x: number; y: number } | null;
  trigger?: ReactNode;
  align?: ComponentProps<typeof PopoverContent>["align"];
  side?: ComponentProps<typeof PopoverContent>["side"];
  className?: string;
  children: ReactNode;
};

export function EditorPopover({
  editor,
  id,
  open,
  onOpenChange,
  at = null,
  trigger,
  align = "start",
  side = "bottom",
  className,
  children,
}: EditorPopoverProps) {
  // Radix carries its own Escape listener, so the kernel must not also
  // dismiss this one; `scope` is what lets a layer opened inside it — a
  // source pane — be recognised as the deeper one.
  const layer = useChromeLayer(editor, {
    id,
    open,
    close: () => onOpenChange(false),
    dismissal: "self",
  });

  return (
    // Keyed on the anchor point for the same reason `EditorMenu` is: floating-ui
    // never sees a fixed anchor move, so a re-open at a new point must be a new
    // popover.
    <Popover
      key={at ? `${at.x},${at.y}` : "trigger"}
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
    >
      {trigger ? (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      ) : (
        <PopoverAnchor
          aria-hidden
          // The pointer's own position, with no size and no hit area: it
          // exists to be measured, never pressed. Geometry rather than theme,
          // so it is inline style — a utility class that failed to ship would
          // silently drop the menu in the top-left corner.
          style={pointerAnchorStyle(at)}
        />
      )}
      <PopoverContent
        align={align}
        side={side}
        className={cn("w-auto", className)}
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
        // A popover holds a form, and in this editor focus is always in
        // motion around one: a menu item that opened this popover drops focus
        // to the body as it unmounts, and every surface hands the caret back
        // to the prose on its way out. Radix would read either as a reason to
        // dismiss, closing a form on the frame it appeared. Escape and a
        // pointer outside still close it, which is what a writer means.
        onFocusOutside={(event) => event.preventDefault()}
      >
        {layer.scope(children)}
      </PopoverContent>
    </Popover>
  );
}
