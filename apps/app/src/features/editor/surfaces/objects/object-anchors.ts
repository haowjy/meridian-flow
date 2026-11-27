import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

import { type NodeHold, resolveNodeHold } from "@/core/editor/anchors";
import { type ObjectSurfaceKind, objectSurfaceKind } from "@/core/editor/objects";

export type ObjectSurfaceTarget = {
  pos: number;
  node: PMNode;
  kind: ObjectSurfaceKind;
  element: HTMLElement;
  /**
   * The node view's own element — where this object's chrome is RENDERED, so
   * that scroll and reflow move the two as one piece and no measurement can
   * strand it (`chrome/object-overlay.ts`).
   *
   * Safe because every object here is a React node view, and a node view
   * ignores DOM changes outside its `contentDOM`: the manuscript's own
   * elements are ProseMirror's, and a child inserted into one of those is read
   * back as a document change. It already bounds the object for the selection
   * ring, inline images included (`editor.css`).
   */
  container: HTMLElement;
};

export function isDiagramFence(node: PMNode): boolean {
  return objectSurfaceKind(node) === "diagram";
}

function renderedBounds(node: PMNode, dom: HTMLElement): HTMLElement {
  if (node.type.name !== "image") return dom;
  return dom.querySelector("img") ?? dom;
}

/**
 * The document position of the node rendered by `element`, or null when the
 * element is not a node's own outermost DOM.
 *
 * `posAtDOM` answers differently for a node view's wrapper than for a plain
 * rendered block — one off-by-one apart — so the candidate is verified by
 * asking the view for that position's DOM back rather than guessed at. The
 * check is what makes this work for React node views, node views the schema
 * renders itself, and whatever a later lane registers.
 */
export function objectPosForElement(view: EditorView, element: HTMLElement): number | null {
  let candidate: number;
  try {
    candidate = view.posAtDOM(element, 0);
  } catch {
    return null;
  }

  for (const pos of [candidate - 1, candidate]) {
    if (pos < 0 || pos > view.state.doc.content.size) continue;
    if (view.state.doc.nodeAt(pos) && view.nodeDOM(pos) === element) return pos;
  }
  return null;
}

export function objectSurfaceAt(
  view: EditorView,
  target: EventTarget | null,
): ObjectSurfaceTarget | null {
  if (!(target instanceof Node)) return null;
  const start = target instanceof HTMLElement ? target : target.parentElement;
  if (!start || !view.dom.contains(start)) return null;

  for (let element: HTMLElement | null = start; element; element = element.parentElement) {
    if (element === view.dom) return null;
    const pos = objectPosForElement(view, element);
    if (pos === null) continue;

    const node = view.state.doc.nodeAt(pos);
    const kind = node ? objectSurfaceKind(node) : null;
    if (!node || !kind) continue;
    return { pos, node, kind, element: renderedBounds(node, element), container: element };
  }

  return null;
}

export function renderedImage(element: HTMLElement): HTMLImageElement | null {
  return element instanceof HTMLImageElement ? element : element.querySelector("img");
}

export function objectSurfaceAtPos(view: EditorView, pos: number): ObjectSurfaceTarget | null {
  const node = view.state.doc.nodeAt(pos);
  const kind = node ? objectSurfaceKind(node) : null;
  if (!node || !kind) return null;

  const element = view.nodeDOM(pos);
  if (!(element instanceof HTMLElement)) return null;
  return { pos, node, kind, element: renderedBounds(node, element), container: element };
}

export function objectSurfaceForHold(
  view: EditorView,
  hold: NodeHold | null,
): ObjectSurfaceTarget | null {
  if (!hold) return null;
  const at = resolveNodeHold(view.state, hold);
  return at ? objectSurfaceAtPos(view, at.from) : null;
}
