/**
 * The four grips a selected picture wears, and the drag they run.
 *
 * They are rendered INSIDE the picture's own node view, which is the object
 * overlay's own default (`features/editor/chrome/object-overlay.ts`): chrome
 * that lives in the element it decorates moves with the manuscript for free —
 * no rect to re-measure, nothing to chase across a scroll, and no way to strand
 * a grip beside the paragraph that took the picture's place.
 *
 * The drag writes nothing until it ends. Each frame sets a width on the
 * picture's own box, which is geometry the writer can see and no peer can; the
 * release is the single transaction the wire and the undo stack ever hear
 * about (`image-resize.ts`).
 */

import type { Editor } from "@tiptap/core";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";

import { holdNode, type NodeHold } from "../anchors";
import {
  IMAGE_RESIZE_CORNERS,
  type ImageResizeCorner,
  type ImageResizeGesture,
  proseLineHeight,
  resizedImageWidth,
  setImageWidth,
} from "./image-resize";

type ActiveResize = {
  gesture: ImageResizeGesture;
  hold: NodeHold;
  pointerId: number;
  origin: { x: number; y: number };
  /** The picture's own box, styled each frame and let go of at the release. */
  box: HTMLElement;
  /** What the box wore before the drag, so a cancelled gesture leaves no trace. */
  restore: string;
  /** Drops every window listener at once, whatever this component re-rendered into. */
  listeners: AbortController;
  width: number;
};

export function ImageResizeHandles({
  editor,
  getPos,
  box,
}: {
  editor: Editor;
  getPos: () => number | undefined;
  box: () => HTMLElement | null;
}) {
  const active = useRef<ActiveResize | null>(null);

  const onPointerDown = (corner: ImageResizeCorner, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || active.current) return;
    const element = box();
    const pos = getPos();
    if (!element || pos === undefined) return;
    const hold = holdNode(editor.view.state, pos);
    const bounds = element.getBoundingClientRect();
    if (!hold || bounds.width <= 0 || bounds.height <= 0) return;

    // The picture IS the drag handle (`inline-drag`), so a press that reached a
    // grip has to say so before the browser starts carrying the picture away.
    event.preventDefault();
    event.stopPropagation();

    const resize: ActiveResize = {
      gesture: {
        corner,
        startWidth: bounds.width,
        ratio: bounds.height / bounds.width,
        minimum: proseLineHeight(element),
        maximum: visibleBoundWidth(element) ?? bounds.width,
      },
      hold,
      pointerId: event.pointerId,
      origin: { x: event.clientX, y: event.clientY },
      box: element,
      restore: element.style.width,
      listeners: new AbortController(),
      width: Math.round(bounds.width),
    };
    active.current = resize;

    const finish = (commit: boolean) => {
      if (active.current !== resize) return;
      active.current = null;
      resize.listeners.abort();
      // A committed width is already on the box; putting the old one back first
      // would flash the picture at its old size for the frame before the
      // re-render. A cancelled gesture leaves nothing behind at all.
      if (commit) setImageWidth(editor, resize.hold, resize.width);
      else resize.box.style.width = resize.restore;
    };

    const mine = (moved: PointerEvent) => moved.pointerId === resize.pointerId;
    const { signal } = resize.listeners;

    window.addEventListener(
      "pointermove",
      (moved) => {
        if (!mine(moved)) return;
        resize.width = resizedImageWidth(resize.gesture, {
          x: moved.clientX - resize.origin.x,
          y: moved.clientY - resize.origin.y,
        });
        // A peer's write can rebuild this element under the drag. The hold still
        // knows which picture it is, so the release still lands; only the
        // preview stops.
        if (resize.box.isConnected) resize.box.style.width = `${resize.width}px`;
      },
      { signal },
    );
    window.addEventListener("pointerup", (up) => mine(up) && finish(true), { signal });
    window.addEventListener("pointercancel", (cancelled) => mine(cancelled) && finish(false), {
      signal,
    });
  };

  return (
    <span className="meridian-image-resize" aria-hidden>
      {IMAGE_RESIZE_CORNERS.map((corner) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: a grip is a pointer affordance with no keyboard equivalent yet, and a role it cannot honour reads worse than being hidden; the keyboard path is in this directory's .context/FUTURE
        <span
          key={corner}
          className={`meridian-image-resize__grip meridian-image-resize__grip--${corner}`}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          onPointerDown={(event) => onPointerDown(corner, event)}
        />
      ))}
    </span>
  );
}

/**
 * The widest this picture can be drawn and still be seen whole: the NARROWEST
 * box between it and the manuscript.
 *
 * Not the block it stands in. That block can be wider than what the writer can
 * see of it — a table cell inside the grid's horizontal scroller is the case
 * that proved it, and reading the block alone let a drag push the far grips out
 * past the scroller's edge where no pointer can reach them. So every box on the
 * way out is asked, and the smallest answer wins; each of them is a real
 * boundary, because a box narrower than its child is a box that clips or
 * scrolls it. The walk ends at the manuscript, which is the outermost thing a
 * picture is ever bounded by.
 *
 * Inline boxes are skipped rather than named: a picture's own wrapper and
 * TipTap's node-view container are both inline, and a box that does not bound a
 * line has no width to offer.
 */
function visibleBoundWidth(element: HTMLElement): number | null {
  let narrowest: number | null = null;
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (!window.getComputedStyle(at).display.startsWith("inline") && at.clientWidth > 0) {
      narrowest = narrowest === null ? at.clientWidth : Math.min(narrowest, at.clientWidth);
    }
    if (at.classList.contains("ProseMirror")) break;
  }
  return narrowest;
}
