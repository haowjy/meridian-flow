/**
 * The ghost a picture drags with.
 *
 * A writer who clicked a big uploaded screenshot and then dragged it got the
 * picture at its FULL NATURAL SIZE following the pointer, covering the paragraph
 * they were aiming at (human ruling, 2026-07-30: keep the drag, lose the ghost).
 *
 * Two different things produce a preview, and which one depends on where the
 * browser decides the drag started:
 *
 * - On an unselected picture the drag starts from the node view's OUTER element,
 *   the one ProseMirror marks draggable, and nothing sets a drag image at all.
 *   The browser answers with its own snapshot of that element: the picture, at
 *   the width the prose column gave it.
 * - On a picture that is already selected the drag starts from the `<img>`
 *   itself, which is inside TipTap's node-view wrapper — so the wrapper's React
 *   `onDragStart` fires and TipTap sets a drag image of its own: a clone of the
 *   node view, off in `document.body`. Every rule that sized the picture is
 *   scoped to the editor, so none of them reach the clone: it lays out as an
 *   inline box (which ignores the width TipTap wrote on it) around an `<img>`
 *   with nothing left to bound it. 3200 pixels of screenshot, on screen.
 *
 * So this sets one preview for both paths, capped, and it has to be the LAST
 * word: TipTap's is set from a React handler, which React dispatches at its root
 * container, and the only place later than that in the same event is above the
 * root. Hence a listener on `window` rather than the editor's own DOM.
 *
 * A slot still uploading has no picture to shrink and keeps whatever the browser
 * does: its frame is a quiet label box, and there is nothing here to improve.
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
    view(view) {
      const nameThePreview = (event: DragEvent) => {
        const target = event.target;
        if (!(target instanceof Node) || !view.dom.contains(target)) return;
        const picture = draggedPicture(target);
        if (picture && event.dataTransfer) setDragPreview(event, event.dataTransfer, picture);
      };
      window.addEventListener("dragstart", nameThePreview);
      return { destroy: () => window.removeEventListener("dragstart", nameThePreview) };
    },
  });
}

/**
 * The picture a dragstart is carrying, or null for anything else being dragged.
 *
 * Both ways up, because the drag source is either the picture's body (or the
 * `<img>` inside it) or the node view element one level ABOVE the body, and
 * neither is reachable from the other by `closest` alone.
 */
function draggedPicture(target: Node): HTMLImageElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const above = target.firstElementChild;
  const body =
    target.closest(IMAGE_BODY_SELECTOR) ??
    (above instanceof HTMLElement && above.matches(IMAGE_BODY_SELECTOR) ? above : null);
  const picture = body?.querySelector("img");
  return picture instanceof HTMLImageElement && picture.complete ? picture : null;
}

/**
 * The ghost has to be a laid-out element the browser can paint, so it is built
 * off screen and taken away again on the next task: the snapshot is made when
 * this event finishes, not when `setDragImage` is called.
 *
 * A `div` around the copy rather than the copy itself, because `setDragImage`
 * given an `<img>` may reach for the image RESOURCE — the picture at its natural
 * size, which is the ghost this exists to prevent.
 */
function setDragPreview(
  event: DragEvent,
  dataTransfer: DataTransfer,
  picture: HTMLImageElement,
): void {
  const from = picture.getBoundingClientRect();
  // Nothing to measure means nothing to promise: the browser's own preview is a
  // better answer than a one-pixel ghost.
  if (from.width < 1 || from.height < 1) return;
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
