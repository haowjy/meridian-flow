/**
 * The ghost a picture drags with.
 *
 * A drag whose dragstart names no drag image leaves the preview entirely to the
 * browser, and the browser's answer for a draggable element is a snapshot of the
 * whole element — for a picture, the picture, at whatever size it is standing on
 * the page. A writer dragging an uploaded screenshot got a plate the size of the
 * prose column following the pointer and hiding the paragraph they were aiming
 * at (human ruling, 2026-07-30: keep the drag, lose the ghost).
 *
 * TipTap's own node views set one, but that handler is a React `onDragStart` on
 * the wrapper INSIDE the node view, and ProseMirror marks the node view's outer
 * element draggable — so the browser fires dragstart on an ancestor of the
 * handler and it never runs. Nothing sets a drag image for an image today; this
 * plugin does, at a size that leaves the manuscript visible under it.
 *
 * A slot still uploading has no picture to shrink, so it keeps the browser's
 * own preview: its frame is a quiet label box, and there is nothing here to
 * improve.
 */

import { Plugin } from "@tiptap/pm/state";

/** The longest edge the ghost may have, so the drop target stays readable. */
export const DRAG_PREVIEW_MAX_EDGE = 240;

/** The picture's own body, which is also the drag handle TipTap requires. */
const IMAGE_BODY_SELECTOR = '.meridian-image-node[data-type="image"]';

export type PreviewBox = { width: number; height: number; scale: number };

/** The ghost's box: the picture's own, shrunk until its long edge fits. */
export function dragPreviewBox(width: number, height: number): PreviewBox {
  const longest = Math.max(width, height);
  const scale = longest > DRAG_PREVIEW_MAX_EDGE ? DRAG_PREVIEW_MAX_EDGE / longest : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}

export function imageDragPreviewPlugin(): Plugin {
  return new Plugin({
    props: {
      handleDOMEvents: {
        dragstart(_view, event) {
          const picture = draggedPicture(event.target);
          // Handed straight on: ProseMirror's own dragstart is what carries the
          // node as an inline slice, and refusing the default here would refuse
          // the gesture outright.
          if (picture && event.dataTransfer) setDragPreview(event, event.dataTransfer, picture);
          return false;
        },
      },
    },
  });
}

/**
 * The picture a dragstart is carrying, or null for anything else being dragged.
 *
 * ProseMirror marks the node view's outer element draggable and TipTap's React
 * renderer puts exactly one child inside it — the picture's body — so the drag
 * source is the body or its parent, and never anything a `closest` from one
 * would find from the other.
 */
function draggedPicture(target: EventTarget | null): HTMLImageElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const body = [target, target.firstElementChild].find(
    (candidate): candidate is HTMLElement =>
      candidate instanceof HTMLElement && candidate.matches(IMAGE_BODY_SELECTOR),
  );
  const picture = body?.querySelector("img");
  return picture instanceof HTMLImageElement && picture.complete ? picture : null;
}

/**
 * The ghost has to be a laid-out element the browser can paint, so it is built
 * off screen and taken away again on the next task: the snapshot is made when
 * this event finishes, not when `setDragImage` is called.
 *
 * A `div` around the copy rather than the copy itself, because `setDragImage`
 * given an `<img>` may reach for the image RESOURCE — the picture at its
 * natural size, which is the ghost this exists to prevent.
 */
function setDragPreview(
  event: DragEvent,
  dataTransfer: DataTransfer,
  picture: HTMLImageElement,
): void {
  const from = picture.getBoundingClientRect();
  const box = dragPreviewBox(from.width, from.height);

  const host = window.document.createElement("div");
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "-10000px";
  host.style.width = `${box.width}px`;
  host.style.height = `${box.height}px`;
  host.style.pointerEvents = "none";

  const ghost = picture.cloneNode(false) as HTMLImageElement;
  ghost.removeAttribute("width");
  ghost.removeAttribute("height");
  ghost.style.width = "100%";
  ghost.style.height = "100%";
  ghost.style.borderRadius = window.getComputedStyle(picture).borderRadius;
  host.append(ghost);
  window.document.body.append(host);

  // The pointer keeps its grip: where it took hold of the picture is where it
  // holds the ghost, scaled with everything else.
  dataTransfer.setDragImage(
    host,
    Math.round((event.clientX - from.left) * box.scale),
    Math.round((event.clientY - from.top) * box.scale),
  );

  window.setTimeout(() => host.remove(), 0);
}
