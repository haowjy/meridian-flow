/**
 * EditorPopover — the editor's anchored surface (link editing, alt text, the
 * slash menu).
 *
 * Same subordination contract as `EditorMenu`: it registers as a layer so the
 * Esc chain knows about it, and closing hands the caret back to the prose.
 *
 * Two things it lets a lane decide that `EditorMenu` cannot.
 *
 * **Where focus goes on the way in.** A popover holding a form takes focus,
 * because the writer opened it to type in it. A popover the writer is still
 * typing UNDERNEATH — the slash menu, filtering as the query grows — must
 * leave the caret in the prose, or the next keystroke lands in the surface.
 *
 * **Whether the anchor can move.** Both anchors are one mechanism, a virtual
 * reference floating-ui measures: `at` is a point that will never move (a
 * right-click landed there), `anchorRect` is a rect that will (the `/` the
 * writer is typing after, inside a manuscript that scrolls). Naming the
 * editor's DOM as the anchor's `contextElement` is what lets floating-ui find
 * the scroll container to watch; without it a virtual anchor only hears the
 * window.
 */

import type { Editor } from "@tiptap/core";
import type { ComponentProps, ReactNode } from "react";
import { useMemo, useRef } from "react";

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

import { useChromeLayer, useReturnFocusToProse } from "./useEditorChrome";

/** floating-ui's measurable reference, plus the element whose scrolling moves it. */
type EditorPopoverAnchor = {
  getBoundingClientRect: () => DOMRect;
  contextElement?: Element;
};

export type EditorPopoverProps = {
  editor: Editor | null;
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Client coordinates for a surface anchored to a place that cannot move. */
  at?: { x: number; y: number } | null;
  /** A rect read on every reposition, for a surface anchored to the text. */
  anchorRect?: (() => DOMRect | null) | null;
  trigger?: ReactNode;
  align?: ComponentProps<typeof PopoverContent>["align"];
  side?: ComponentProps<typeof PopoverContent>["side"];
  /** `prose` leaves the caret where it was; the default takes focus in. */
  focusOnOpen?: "content" | "prose";
  className?: string;
  children: ReactNode;
};

export function EditorPopover({
  editor,
  id,
  open,
  onOpenChange,
  at = null,
  anchorRect = null,
  trigger,
  align = "start",
  side = "bottom",
  focusOnOpen = "content",
  className,
  children,
}: EditorPopoverProps) {
  const returnFocus = useReturnFocusToProse(editor);
  const layer = useChromeLayer(editor, { id, open, close: () => onOpenChange(false) });

  // Read through a ref so the anchor object stays identical across renders:
  // Radix re-points the popper at `virtualRef.current` on every render, and a
  // fresh object each time would restart positioning mid-keystroke.
  const measure = useRef<() => DOMRect | null>(() => null);
  measure.current = anchorRect ?? (() => (at ? new DOMRect(at.x, at.y, 0, 0) : null));

  const contextElement = editor && !editor.isDestroyed ? editor.view.dom : undefined;
  const virtualRef = useMemo<{ current: EditorPopoverAnchor }>(
    () => ({
      current: {
        getBoundingClientRect: () => measure.current() ?? new DOMRect(),
        contextElement,
      },
    }),
    [contextElement],
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange} modal={false}>
      {trigger ? (
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      ) : (
        <PopoverAnchor virtualRef={virtualRef} />
      )}
      <PopoverContent
        align={align}
        side={side}
        className={cn("w-auto", className)}
        onOpenAutoFocus={focusOnOpen === "prose" ? preventFocusIn : undefined}
        onCloseAutoFocus={returnFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

function preventFocusIn(event: Event) {
  event.preventDefault();
}
