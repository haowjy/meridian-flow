import type { EditorView } from "@tiptap/pm/view";

import { type ObjectBody, objectBody } from "@/core/editor/objects";
// Straight at the primitive rather than through `chrome/index.ts`: that barrel
// also carries the surface registry this lane is listed in, so the barrel route
// is a module cycle.
import { type OverlayBox, overlayRect } from "@/features/editor/chrome/manuscript-overlay";

import { type BlockTarget, blockAt, objectIsWholeBlock } from "./block-targets";

export const BLOCK_HANDLE_WIDTH = 22;
export const BLOCK_HANDLE_HEIGHT = 24;

const HANDLE_CLEARANCE = 22;

export const MARGIN_GUTTER_MIN = HANDLE_CLEARANCE + BLOCK_HANDLE_WIDTH + 4;

const END_SEAM_OFFSET = 6;

const BLOCK_HOVER_SLACK_PX = 8;

type ColumnEdges = { left: number; right: number };

export function blockElement(view: EditorView, pos: number): HTMLElement | null {
  const dom = view.nodeDOM(pos);
  return dom instanceof HTMLElement ? dom : null;
}

function proseColumnEdges(view: EditorView, overlay: HTMLElement): ColumnEdges | null {
  const rect = overlayRect(overlay, view.dom);
  if (!rect) return null;
  const style = window.getComputedStyle(view.dom);
  return {
    left: rect.left + pixels(style.paddingLeft),
    right: rect.right - pixels(style.paddingRight),
  };
}

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

const OBJECT_BODY_CONTROLS = "input, textarea, select, button, a[href]";

export function objectBodyDragTarget(view: EditorView, event: PointerEvent): BlockTarget | null {
  if (!(event.target instanceof Element)) return null;
  if (onEditableText(event.target) || event.target.closest(OBJECT_BODY_CONTROLS)) return null;

  const object = objectAtPointer(view, event.clientX, event.clientY, "block-drag");
  if (object === null || !objectIsWholeBlock(view.state.doc, object)) return null;
  return blockAt(view.state.doc, object);
}

export function nativeDragCarriesObject(view: EditorView, event: DragEvent): boolean {
  if (event.target instanceof Element && onEditableText(event.target)) return false;
  return objectAtPointer(view, event.clientX, event.clientY, "block-drag") !== null;
}

function onEditableText(element: Element): boolean {
  return element.closest("[contenteditable]")?.getAttribute("contenteditable") !== "false";
}

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
