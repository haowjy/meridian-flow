/**
 * EditorPopover — the editor's anchored surface (link editing, alt text, the
 * slash menu).
 *
 * Same subordination contract as `EditorMenu`: it registers as a layer so the
 * Esc chain knows about it, and closing hands the caret back to the prose.
 *
 * Two things it lets a lane decide that `EditorMenu` cannot, and one it does
 * not: focus alone never dismisses a popover here. Focus is always in motion
 * around an editor surface — a menu unmounting drops it to the body, every
 * close hands the caret back to the prose — and Radix would read each move as
 * a reason to close, killing a form on the frame it appeared. Escape and a
 * pointer outside still dismiss, which is what a writer means by it.
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
 *
 * **No anchor is not an anchor at the origin.** An unmeasurable anchor answers
 * null — the trigger's decoration has left the DOM, the caller has nothing to
 * point at yet — and this surface then does not mount, the same answer
 * `useAnchorRect` gives measured chrome. Inventing a zero `DOMRect` put a live
 * menu in the viewport's top-left corner, over content it had nothing to do
 * with and with no way for the writer to read what it belonged to.
 */

import type { Editor } from "@tiptap/core";
import type { ComponentProps, ReactNode } from "react";
import { useMemo, useRef } from "react";

import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useChromeLayer } from "./chrome-layers";

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
  /** Where focus goes on close; the default hands the caret back to the prose. */
  returnFocus?: () => void;
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
  returnFocus,
  className,
  children,
}: EditorPopoverProps) {
  // Read through a ref so the anchor object stays identical across renders:
  // Radix re-points the popper at `virtualRef.current` on every render, and a
  // fresh object each time would restart positioning mid-keystroke.
  const measure = useRef<() => DOMRect | null>(() => null);
  measure.current = anchorRect ?? (() => (at ? new DOMRect(at.x, at.y, 0, 0) : null));

  // The last place this anchor was, kept for as long as the surface is open.
  // floating-ui asks for a rect synchronously and has no way to hear "not just
  // now", so a single frame where the anchor cannot be measured — a remote
  // write rebuilding the manuscript between two paints — answers with where it
  // last was rather than with a corner. Never measured at all is the different
  // answer: there is nowhere to put this, so it does not open.
  const placed = useRef<DOMRect | null>(null);
  const here = measure.current();
  if (!open) placed.current = null;
  else if (here) placed.current = here;
  const mounted = open && (Boolean(trigger) || placed.current !== null);

  // Radix carries its own Escape listener, so the kernel must not also
  // dismiss this one; `scope` is what lets a layer opened inside it — a
  // source pane — be recognised as the deeper one.
  //
  // The LANE's `open`, not the anchored `mounted`: whether a surface can be
  // drawn is geometry, whether it is open is the lane's own state, and a
  // surface whose anchor cannot be measured must still be the one thing Escape
  // closes and Mod+K replaces. Registering on the mount instead would leave an
  // unplaceable surface open with nothing able to close it.
  const layer = useChromeLayer(editor, {
    id,
    open,
    close: () => onOpenChange(false),
    dismissal: "self",
    returnFocus,
  });

  const contextElement = editor && !editor.isDestroyed ? editor.view.dom : undefined;
  const virtualRef = useMemo<{ current: EditorPopoverAnchor }>(
    () => ({
      current: {
        getBoundingClientRect: () => measure.current() ?? placed.current ?? new DOMRect(),
        contextElement,
      },
    }),
    [contextElement],
  );

  return (
    <Popover open={mounted} onOpenChange={onOpenChange} modal={false}>
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
        onCloseAutoFocus={layer.onCloseAutoFocus}
        onEscapeKeyDown={layer.onEscapeKeyDown}
        // Focus alone is not a dismissal here; see the header.
        onFocusOutside={preventDismissal}
      >
        {layer.scope(children)}
      </PopoverContent>
    </Popover>
  );
}

function preventFocusIn(event: Event) {
  event.preventDefault();
}

function preventDismissal(event: { preventDefault: () => void }) {
  event.preventDefault();
}
