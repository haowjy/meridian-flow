/** Measures manuscript blocks and drop seams. */

import type { EditorView } from "@tiptap/pm/view";

import { type ObjectBody, objectBody } from "@/core/editor/objects";
// Straight at the primitive rather than through `chrome/index.ts`: that barrel
// also carries the surface registry this lane is listed in, so the barrel route
// is a module cycle.
import { type OverlayBox, overlayRect } from "@/features/editor/chrome/manuscript-overlay";

import { type BlockTarget, blockAt, objectIsWholeBlock } from "./block-targets";

/** Matches mockup 08: a 22×24 grip. */
export const BLOCK_HANDLE_WIDTH = 22;
export const BLOCK_HANDLE_HEIGHT = 24;

/** How far the handle's right edge sits inside the text edge. */
const HANDLE_CLEARANCE = 22;

/** How much gutter the prose column has to leave left of its text edge. */
export const MARGIN_GUTTER_MIN = HANDLE_CLEARANCE + BLOCK_HANDLE_WIDTH + 4;

/** How far the drop line floats off the outer edges of the document. */
const END_SEAM_OFFSET = 6;

/** Slack around a block's box when deciding whether the pointer is on it, so a pointer crossing the gap between two paragraphs does not fall into nothing and blink the handle off. */
const BLOCK_HOVER_SLACK_PX = 8;

type ColumnEdges = { left: number; right: number };

/** The rendered element of a top-level block, or null when it has none yet. */
export function blockElement(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/** The prose column's left and right text edges: inside the ProseMirror node's own padding. */
function proseColumnEdges(view: EditorView, overlay: HTMLElement): ColumnEdges | null {
  const rect = overlayRect(overlay, view.dom);
  if (!rect) return null;
  const style = window.getComputedStyle(view.dom);
  return {
    left: rect.left + pixels(style.paddingLeft),
    right: rect.right - pixels(style.paddingRight),
  };
}

/** Where the handle for `block` sits, in the overlay's coordinates. */
export function blockHandlePosition(
  view: EditorView,
  overlay: HTMLElement,
  block: BlockTarget,
): { top: number; left: number } | null {
  const element = blockElement(view, block.pos);
  if (!element) return null;

  const rect = overlayRect(overlay, element);
  const column = proseColumnEdges(view, overlay);
  if (!rect || !column) return null;

  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const lead = Number.isFinite(lineHeight)
    ? Math.max(0, (lineHeight - BLOCK_HANDLE_HEIGHT) / 2)
    : 4;

  return {
    top: rect.top + pixels(style.paddingTop) + lead,
    left: column.left - HANDLE_CLEARANCE - BLOCK_HANDLE_WIDTH,
  };
}

/** The block the pointer is on, or null when it is on none. */
export function blockUnderPointer(
  view: EditorView,
  clientX: number,
  clientY: number,
): BlockTarget | null {
  const column = proseColumnEdgesInViewport(view);
  const at = view.posAtCoords({
    left: Math.min(Math.max(clientX, column.left + 1), column.right - 1),
    top: clientY,
  });
  if (!at) return null;

  const block = blockAt(view.state.doc, at.pos);
  if (!block) return null;
  const rect = blockElement(view, block.pos)?.getBoundingClientRect();
  if (!rect) return null;
  return clientY >= rect.top - BLOCK_HOVER_SLACK_PX && clientY <= rect.bottom + BLOCK_HOVER_SLACK_PX
    ? block
    : null;
}

/** Controls a node view puts inside its own body: a figure's alt and caption fields, an image's retry button. */
const OBJECT_BODY_CONTROLS = "input, textarea, select, button, a[href]";

/** The block a press on an object's body should drag, or null when the press starts no block drag. */
export function objectBodyDragTarget(view: EditorView, event: PointerEvent): BlockTarget | null {
  if (!(event.target instanceof Element)) return null;
  if (onEditableText(event.target) || event.target.closest(OBJECT_BODY_CONTROLS)) return null;

  const object = objectAtPointer(view, event.clientX, event.clientY, "block-drag");
  if (object === null || !objectIsWholeBlock(view.state.doc, object)) return null;
  return blockAt(view.state.doc, object);
}

/** True when the browser's own drag would carry a BLOCK object off. */
export function nativeDragCarriesObject(view: EditorView, event: DragEvent): boolean {
  if (event.target instanceof Element && onEditableText(event.target)) return false;
  return objectAtPointer(view, event.clientX, event.clientY, "block-drag") !== null;
}

/** True when the element is text the writer can type into, rather than the inert surface a node view draws in front of its own content. */
function onEditableText(element: Element): boolean {
  return element.closest("[contenteditable]")?.getAttribute("contenteditable") !== "false";
}

/**
 * The position of the object under these coordinates whose body is `body`, or
 * null when the coordinates are on something else.
 */
function objectAtPointer(
  view: EditorView,
  clientX: number,
  clientY: number,
  body: ObjectBody,
): number | null {
  const at = view.posAtCoords({ left: clientX, top: clientY });
  if (!at || at.inside < 0) return null;
  const node = view.state.doc.nodeAt(at.inside);
  return node && objectBody(node) === body ? at.inside : null;
}

/** Which seam the pointer is asking for: the nearest edge of the block it is over, above or below its middle. */
export function seamIndexAtPointer(view: EditorView, clientY: number): number {
  const { doc } = view.state;
  let pos = 0;

  for (let index = 0; index < doc.childCount; index += 1) {
    const element = blockElement(view, pos);
    pos += doc.child(index).nodeSize;
    if (!element) continue;

    const rect = element.getBoundingClientRect();
    if (clientY < rect.top) return index;
    if (clientY <= rect.bottom) return clientY < rect.top + rect.height / 2 ? index : index + 1;
  }

  return doc.childCount;
}

/** Where the jade line is drawn for `seamIndex`, in the overlay's coordinates. */
export function seamLinePosition(
  view: EditorView,
  overlay: HTMLElement,
  seamIndex: number,
): { top: number; left: number; width: number } | null {
  const { doc } = view.state;
  const column = proseColumnEdges(view, overlay);
  if (!column) return null;
  const geometry = { left: column.left, width: Math.max(0, column.right - column.left) };

  const above = seamIndex > 0 ? blockRectAtIndex(view, overlay, seamIndex - 1) : null;
  const below = seamIndex < doc.childCount ? blockRectAtIndex(view, overlay, seamIndex) : null;

  if (above && below) return { ...geometry, top: (above.bottom + below.top) / 2 };
  if (below) return { ...geometry, top: below.top - END_SEAM_OFFSET };
  if (above) return { ...geometry, top: above.bottom + END_SEAM_OFFSET };
  return null;
}

function blockRectAtIndex(
  view: EditorView,
  overlay: HTMLElement,
  index: number,
): OverlayBox | null {
  const { doc } = view.state;
  if (index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let before = 0; before < index; before += 1) pos += doc.child(before).nodeSize;
  const element = blockElement(view, pos);
  return element ? overlayRect(overlay, element) : null;
}

/** The same two edges the pointer is compared against, in the pointer's space. */
function proseColumnEdgesInViewport(view: EditorView): ColumnEdges {
  const rect = view.dom.getBoundingClientRect();
  const style = window.getComputedStyle(view.dom);
  return {
    left: rect.left + pixels(style.paddingLeft),
    right: rect.right - pixels(style.paddingRight),
  };
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
