/**
 * Where an object's corner chrome is drawn, and in whose coordinates.
 *
 * Ruling 8 puts every object's controls just inside its own top-right bounds
 * with zero footprint: no band above the object, no reserved space, nothing
 * that moves a line of the manuscript when it appears. There are two ways to
 * be in that corner, and the difference is who owns the DOM.
 *
 * **Inside**, whenever the object is a node view. The controls are rendered in
 * the object's own element and placed by CSS, so scroll and reflow move chrome
 * and object as one piece: there is no rect to chase and therefore no way to
 * strand the chrome beside the paragraph that took the object's place. This is
 * the collaborator cursor's own model, and it is the default.
 *
 * **Over**, where the element belongs to ProseMirror rather than to a node view
 * — a table. ProseMirror reads its own elements back as document content, so a
 * child inserted into one is a document change it will try to parse. Those
 * controls stay measured and portalled, riding `watchManuscriptLayout` for
 * their geometry and the kernel's hover anchors for their target. They are
 * measured into the manuscript overlay rather than the viewport
 * (`manuscript-overlay.ts`), so the one thing they still cannot do is leave
 * the editor: measured against the viewport, a table scrolled halfway out of
 * the pane put its own menu chip over the app's breadcrumb.
 */

import type { Editor } from "@tiptap/core";
import { type CSSProperties, useEffect, useReducer } from "react";

import { manuscriptOverlay } from "./manuscript-overlay";
import { useAnchorRect } from "./useAnchorRect";
import "./object-overlay.css";

export type ObjectOverlayCorner = { inside: HTMLElement } | { over: HTMLElement };

export type ObjectOverlayPlacement = {
  container: Element;
  placement: "inside" | "over";
  style: CSSProperties | undefined;
};

const OVERLAY_INSET_PX = 10;

export function useObjectOverlayCorner(
  editor: Editor | null,
  corner: ObjectOverlayCorner | null,
): ObjectOverlayPlacement | null {
  const measured = corner && "over" in corner ? corner.over : null;
  const rect = useAnchorRect(editor, measured);
  const overlay = manuscriptOverlay(editor);
  const inside = useRenderedNodeView(corner && "inside" in corner ? corner.inside : null);

  if (!corner || typeof document === "undefined") return null;

  if ("inside" in corner) {
    if (!inside) return null;
    return { container: inside, placement: "inside", style: undefined };
  }

  if (!rect || !overlay) return null;
  return {
    container: overlay,
    placement: "over",
    style: { top: rect.top + OVERLAY_INSET_PX, left: rect.right - OVERLAY_INSET_PX },
  };
}

/**
 * The node view's element once TipTap has rendered its `NodeViewWrapper` into it. TipTap's node
 * view throws from every DOM check ProseMirror makes (a mutation, a destroy) while the element's
 * first child is not the wrapper, and a throw there leaves the view without the node on screen. A
 * node view made by a move, a paste or a peer's write renders its wrapper later than our chrome
 * would, so the chrome waits for it and is appended after it.
 */
function useRenderedNodeView(element: HTMLElement | null): HTMLElement | null {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const rendered = element?.isConnected === true && hasWrapper(element);

  useEffect(() => {
    if (!element || rendered) return;
    const observer = new MutationObserver(() => {
      if (hasWrapper(element)) rerender();
    });
    observer.observe(element, { childList: true });
    // The wrapper may have arrived in the same commit as this render, before the observer.
    if (hasWrapper(element)) rerender();
    return () => observer.disconnect();
  }, [element, rendered]);

  return rendered ? element : null;
}

function hasWrapper(element: HTMLElement): boolean {
  const first = element.firstElementChild;
  // A node view with content first holds TipTap's content element, marked as a wrapper too, until
  // React renders the real wrapper and TipTap moves the content into it.
  return (
    first?.hasAttribute("data-node-view-wrapper") === true &&
    !first.hasAttribute("data-node-view-content-react")
  );
}
