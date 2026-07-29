/**
 * Where the chrome goes: the margin the handle sits in, and the seam a
 * dragging pointer is asking for.
 *
 * The document half of block movement is positions (`block-targets.ts`); this
 * is the half that has to look at what the browser actually drew. Both the
 * handle and the drop line are fixed-position overlays measured from the
 * rendered boxes, never elements inside the prose — law 7 forbids chrome that
 * moves a line of the manuscript, and a widget decoration between two blocks
 * would inherit the manuscript's own block spacing and push the page down by
 * exactly its height.
 */

import type { EditorView } from "@tiptap/pm/view";

import { type BlockTarget, blockAt } from "./block-targets";

/** Matches mockup 08: a 22×24 grip, roughly 12px clear of the text edge. */
export const BLOCK_HANDLE_WIDTH = 22;
export const BLOCK_HANDLE_HEIGHT = 24;
const HANDLE_GAP = 12;

/** How far the drop line floats off the outer edges of the document. */
const END_SEAM_OFFSET = 6;

export type ViewportBox = { top: number; left: number; right: number; bottom: number };

/** The rendered element of a top-level block, or null when it has none yet. */
export function blockElement(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

/**
 * The prose column's content box: inside the ProseMirror node's own padding,
 * which is where the text edge actually is. The drop line spans it and the
 * handle hangs off its left, so both agree with the column rather than with
 * whichever block happens to be adjacent (a centered table is narrower than
 * the paragraph above it).
 */
export function proseContentBox(view: EditorView): ViewportBox {
  const rect = view.dom.getBoundingClientRect();
  const style = window.getComputedStyle(view.dom);
  return {
    top: rect.top + pixels(style.paddingTop),
    bottom: rect.bottom - pixels(style.paddingBottom),
    left: rect.left + pixels(style.paddingLeft),
    right: rect.right - pixels(style.paddingRight),
  };
}

/**
 * Where the handle for `block` sits, in viewport coordinates.
 *
 * Vertically it aligns with the block's first LINE rather than its box, so it
 * reads as belonging to the sentence beside it: a heading's line is taller
 * than a paragraph's and a code fence's text starts below its own padding.
 */
export function blockHandlePosition(
  view: EditorView,
  block: BlockTarget,
): { top: number; left: number } | null {
  const element = blockElement(view, block.pos);
  if (!element) return null;

  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  const lead = Number.isFinite(lineHeight)
    ? Math.max(0, (lineHeight - BLOCK_HANDLE_HEIGHT) / 2)
    : 4;

  const column = proseContentBox(view);
  return {
    top: rect.top + pixels(style.paddingTop) + lead,
    left: column.left - HANDLE_GAP - BLOCK_HANDLE_WIDTH,
  };
}

/**
 * The document position the pointer is over, with x pulled into the prose
 * column first: the pointer spends the whole approach in the margin, and
 * `posAtCoords` there answers about the gutter or not at all.
 */
export function blockUnderPointer(view: EditorView, clientX: number, clientY: number) {
  const column = proseContentBox(view);
  if (clientY < column.top || clientY > column.bottom) return null;

  const at = view.posAtCoords({
    left: Math.min(Math.max(clientX, column.left + 1), column.right - 1),
    top: clientY,
  });
  if (!at) return null;
  return blockAt(view.state.doc, at.pos);
}

/**
 * Which seam the pointer is asking for: the nearest edge of the block it is
 * over, above or below its middle. Off the top of the document it is the first
 * seam and off the bottom the last, so a pointer dragged past the end still
 * has an answer rather than losing the line.
 */
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

/** Where the jade line is drawn for `seamIndex`, in viewport coordinates. */
export function seamLinePosition(
  view: EditorView,
  seamIndex: number,
): { top: number; left: number; width: number } | null {
  const { doc } = view.state;
  const column = proseContentBox(view);
  const geometry = { left: column.left, width: Math.max(0, column.right - column.left) };

  const above = seamIndex > 0 ? blockRectAtIndex(view, seamIndex - 1) : null;
  const below = seamIndex < doc.childCount ? blockRectAtIndex(view, seamIndex) : null;

  if (above && below) return { ...geometry, top: (above.bottom + below.top) / 2 };
  if (below) return { ...geometry, top: below.top - END_SEAM_OFFSET };
  if (above) return { ...geometry, top: above.bottom + END_SEAM_OFFSET };
  return null;
}

function blockRectAtIndex(view: EditorView, index: number): DOMRect | null {
  const { doc } = view.state;
  if (index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let before = 0; before < index; before += 1) pos += doc.child(before).nodeSize;
  return blockElement(view, pos)?.getBoundingClientRect() ?? null;
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
