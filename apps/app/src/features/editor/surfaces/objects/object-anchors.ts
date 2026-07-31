/**
 * Which object a surface is aimed at, and which elements draw it right now.
 *
 * The kernel resolves document positions; turning a position into DOM — and a
 * pointer into a position — is the lane's job, because only the lane knows its
 * node views' shape. Everything here is a reading over an `EditorView`; nothing
 * dispatches.
 *
 * **Elements are geometry, holds are identity.** A target is derived at the
 * moment it is needed and never stored: its elements belong to node views a
 * remote write replaces. What a surface stores between frames is a `NodeHold`,
 * and `objectSurfaceForHold` is how it gets back to the page.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";

import { type NodeHold, resolveNodeHold } from "@/core/editor/anchors";
import { type ObjectSurfaceKind, objectSurfaceKind } from "@/core/editor/objects";

export type ObjectSurfaceTarget = {
  pos: number;
  node: PMNode;
  kind: ObjectSurfaceKind;
  /**
   * What the overlay anchors to: the object's rendered bounds, which is not
   * always the node's own DOM. Resolving a position back from it walks up
   * (`objectSurfaceAt`), so it stays a valid handle either way.
   */
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

/** A fence a provider renders as a diagram, rather than one to type in. */
export function isDiagramFence(node: PMNode): boolean {
  return objectSurfaceKind(node) === "diagram";
}

/**
 * The element whose box IS the object, as the writer sees it.
 *
 * An inline image lives inside a wrapper TipTap lays out as text, so that
 * wrapper's box is a line box a fraction of the picture's height — anchoring
 * the row to it would float the controls somewhere down the image's side. The
 * picture's own bounds are what ruling 8 means by "inside the object's
 * top-right". A figure keeps its card, caption and all.
 */
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
    return { pos, node, kind, element: renderedBounds(node, element), container: element };
  }

  return null;
}

/**
 * The picture inside an image target — which may be the anchor itself, since
 * an inline image anchors to its own bounds rather than to its wrapper.
 *
 * The rendered element already carries a resolved `src` (an `asset:` ref
 * became a signed URL on the way into the page), so every verb that needs the
 * picture reads it back from here rather than resolving the asset again.
 */
export function renderedImage(element: HTMLElement): HTMLImageElement | null {
  return element instanceof HTMLImageElement ? element : element.querySelector("img");
}

/** The surface target at a known document position, resolved back to DOM. */
export function objectSurfaceAtPos(view: EditorView, pos: number): ObjectSurfaceTarget | null {
  const node = view.state.doc.nodeAt(pos);
  const kind = node ? objectSurfaceKind(node) : null;
  if (!node || !kind) return null;

  const element = view.nodeDOM(pos);
  if (!(element instanceof HTMLElement)) return null;
  return { pos, node, kind, element: renderedBounds(node, element), container: element };
}

/**
 * The surface target a hold is aimed at, resolved against the page as it now
 * stands, or null once the object is gone (or has not been re-rendered yet).
 */
export function objectSurfaceForHold(
  view: EditorView,
  hold: NodeHold | null,
): ObjectSurfaceTarget | null {
  if (!hold) return null;
  const at = resolveNodeHold(view.state, hold);
  return at ? objectSurfaceAtPos(view, at.from) : null;
}
