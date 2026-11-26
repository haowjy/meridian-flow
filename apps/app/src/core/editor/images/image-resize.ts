import type { Editor } from "@tiptap/core";

import { type NodeHold, resolveNodeHold } from "../anchors";

export type ImageResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const IMAGE_RESIZE_CORNERS: readonly ImageResizeCorner[] = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
];

export type ImageResizeGesture = {
  corner: ImageResizeCorner;
  startWidth: number;
  ratio: number;
  minimum: number;
  maximum: number;
};

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

function cornerDirection(corner: ImageResizeCorner): { x: number; y: number } {
  return {
    x: corner === "top-right" || corner === "bottom-right" ? 1 : -1,
    y: corner === "bottom-left" || corner === "bottom-right" ? 1 : -1,
  };
}

export function proseLineHeight(element: Element): number {
  const style = window.getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(style.fontSize);
  return Number.isFinite(fontSize) && fontSize > 0 ? fontSize * 1.5 : 24;
}

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

export function imageWidthAttr(attrs: Record<string, unknown>): number | null {
  const width = attrs.width;
  return typeof width === "number" && Number.isFinite(width) && width > 0 ? width : null;
}

export function setImageWidth(editor: Editor, hold: NodeHold, width: number | null): boolean {
  if (editor.isDestroyed || !editor.isEditable) return false;
  const { state } = editor.view;
  const at = resolveNodeHold(state, hold);
  if (!at) return false;
  const node = state.doc.nodeAt(at.from);
  if (!node || imageWidthAttr(node.attrs) === width) return false;
  // `setNodeMarkup` replaces a leaf, which would drop the selection and its grips.
  editor.view.dispatch(state.tr.setNodeAttribute(at.from, "width", width));
  return true;
}
