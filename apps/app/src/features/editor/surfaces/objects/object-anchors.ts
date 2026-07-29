/**
 * Which object is being approached, and which element is it.
 *
 * The kernel resolves document positions; turning a position into DOM — and a
 * pointer into a position — is the lane's job, because only the lane knows its
 * node views' shape. Everything here is a reading over an `EditorView`; nothing
 * dispatches.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

/**
 * Which control surface a node gets. Not the same question as "is this an
 * object" (`EDITOR_OBJECT_TYPES` answers that): a plain code fence is prose the
 * writer types into and still carries a chip cluster, and a rendered mermaid
 * fence is the same node type wearing the other face.
 */
export type ObjectSurfaceKind = "diagram" | "image" | "code";

export type ObjectSurfaceTarget = {
  pos: number;
  node: PMNode;
  kind: ObjectSurfaceKind;
  /** The node's rendered element — what the overlay anchors to. */
  element: HTMLElement;
};

export function isMermaidFence(node: PMNode): boolean {
  return node.type.name === "code_block" && node.attrs.language === "mermaid";
}

export function objectSurfaceKind(node: PMNode): ObjectSurfaceKind | null {
  if (node.type.name === "code_block") return isMermaidFence(node) ? "diagram" : "code";
  if (node.type.name === "image" || node.type.name === "figure") return "image";
  return null;
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

/**
 * The object under a pointer, found by walking up from what the pointer hit.
 *
 * Up rather than down: the pointer lands on a diagram's `<path>` or an image
 * itself, and the anchor is the node's outermost element several levels above.
 * The walk stops at the editor's own DOM, so chrome portalled elsewhere never
 * resolves to an object it happens to overlap.
 */
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
    return { pos, node, kind, element };
  }

  return null;
}

/** The surface target at a known document position, resolved back to DOM. */
export function objectSurfaceAtPos(view: EditorView, pos: number): ObjectSurfaceTarget | null {
  const node = view.state.doc.nodeAt(pos);
  const kind = node ? objectSurfaceKind(node) : null;
  if (!node || !kind) return null;

  const element = view.nodeDOM(pos);
  if (!(element instanceof HTMLElement)) return null;
  return { pos, node, kind, element };
}
