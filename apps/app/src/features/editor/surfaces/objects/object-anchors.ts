import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

import { type NodeHold, resolveNodeHold } from "@/core/editor/anchors";
import { type ObjectSurfaceKind, objectSurfaceKind } from "@/core/editor/objects";

export type ObjectSurfaceTarget = {
  pos: number;
  node: PMNode;
  kind: ObjectSurfaceKind;
  element: HTMLElement;
  container: HTMLElement;
};

export function isDiagramFence(node: PMNode): boolean {
  return objectSurfaceKind(node) === "diagram";
}

function renderedBounds(node: PMNode, dom: HTMLElement): HTMLElement {
  if (node.type.name !== "image") return dom;
  return dom.querySelector("img") ?? dom;
}

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
