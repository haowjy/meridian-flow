/**
 * How big the writer wants this picture, and the one gesture that says so.
 *
 * A picture arrives at the size of the file it came from, capped by the prose
 * column, and that is what `width: null` means — the state nearly every picture
 * is in, and the state whose wire form stays plain `![alt](src)`. Dragging a
 * corner writes a number into the document instead, so every peer draws the
 * picture the writer's size rather than their own reading of the file (human
 * ruling, 2026-07-30: the Docs model, and the way a big picture becomes small
 * enough for words to stand beside it in the line).
 *
 * Two rules make the gesture one event rather than a hundred. The drag itself
 * is GEOMETRY — a style on the element, written each frame, seen by nobody but
 * the writer — and only the release is a transaction. So the wire carries one
 * attribute change, the peers repaint once, and undo takes the whole drag back
 * in a single step.
 *
 * The size is held by identity, never by a number: the operating system is not
 * involved, but a peer or an AI write can still move the picture between the
 * press and the release, and a raw position then aims at prose.
 */

import type { Editor } from "@tiptap/core";

import { type NodeHold, resolveNodeHold } from "../anchors";

/** Which corner the writer took hold of. */
export type ImageResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const IMAGE_RESIZE_CORNERS: readonly ImageResizeCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

/** Everything the drag needs, read once at the press. */
export type ImageResizeGesture = {
  corner: ImageResizeCorner;
  /** The picture's rendered width when the press landed, in CSS pixels. */
  startWidth: number;
  /** Height over width, so the drag can only ever change one number. */
  ratio: number;
  /** Small enough to be a picture, big enough to still be one: a line of prose. */
  minimum: number;
  /**
   * The narrowest box between the picture and the manuscript: the prose column,
   * or the cell and the scroller a table gives it instead. A picture is never
   * wider than what the writer can see of the place it stands in.
   */
  maximum: number;
};

/**
 * The width a pointer offset asks for, aspect preserved and column capped.
 *
 * The pointer rarely travels along the picture's own diagonal, so the offset is
 * PROJECTED onto it: the returned box is the one closest to where the pointer
 * actually is, which is what makes the corner feel attached to the hand. Taking
 * the horizontal alone would ignore a straight-down drag; taking whichever axis
 * moved more would jump between two answers mid-gesture.
 */
export function resizedImageWidth(
  gesture: ImageResizeGesture,
  offset: { x: number; y: number },
): number {
  const outward = cornerDirection(gesture.corner);
  const along =
    (offset.x * outward.x + offset.y * outward.y * gesture.ratio) / (1 + gesture.ratio ** 2);
  const width = gesture.startWidth + along;
  return Math.round(Math.min(Math.max(width, gesture.minimum), gesture.maximum));
}

/** Which way is bigger, from the corner the writer grabbed. */
function cornerDirection(corner: ImageResizeCorner): { x: number; y: number } {
  return {
    x: corner === "top-right" || corner === "bottom-right" ? 1 : -1,
    y: corner === "bottom-left" || corner === "bottom-right" ? 1 : -1,
  };
}

/**
 * A picture may not shrink below the line it stands in.
 *
 * The prose line height is the floor because it is the smallest thing the page
 * already draws: a picture at one line is still a glyph among the words, and
 * anything under that is a picture the writer can no longer grab to undo.
 * `line-height: normal` computes to a keyword rather than a length, so the
 * font's own size stands in for it.
 */
export function proseLineHeight(element: Element): number {
  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : 24;
}

/**
 * The attribute as the editor's schema declares it, mirroring
 * `@meridian/prosemirror-schema`.
 *
 * It IS rendered to HTML, unlike the upload token: `width` is what a picture
 * copied out of the manuscript should carry into wherever it is pasted, and it
 * is how the same picture comes back in.
 */
export const IMAGE_WIDTH_ATTRIBUTE = {
  default: null,
  parseHTML: (element: HTMLElement) => parsedWidth(element.getAttribute("width")),
  renderHTML: (attrs: Record<string, unknown>) => {
    const width = imageWidthAttr(attrs);
    return width === null ? {} : { width: String(width) };
  },
};

function parsedWidth(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const width = Number(value);
  return Number.isSafeInteger(width) && width > 0 ? width : null;
}

/** The picture's stored display width, or null for one at its natural size. */
export function imageWidthAttr(attrs: Record<string, unknown>): number | null {
  const width = attrs.width;
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : null;
}

/**
 * Write the size the writer let go at, as one historical event.
 *
 * Every other attribute is carried across untouched, `uploadToken` included: a
 * picture still on its way is an ordinary node with an ordinary size, and a
 * resize that dropped the token would abandon the bytes in flight.
 */
export function setImageWidth(editor: Editor, hold: NodeHold, width: number | null): void {
  if (editor.isDestroyed || !editor.isEditable) return;
  const { state } = editor.view;
  const at = resolveNodeHold(state, hold);
  if (!at) return;
  const node = state.doc.nodeAt(at.from);
  if (!node || imageWidthAttr(node.attrs) === width) return;
  editor.view.dispatch(state.tr.setNodeMarkup(at.from, undefined, { ...node.attrs, width }));
}
