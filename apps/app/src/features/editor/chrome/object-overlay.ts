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
import type { CSSProperties } from "react";

import { manuscriptOverlay } from "./manuscript-overlay";
import { useAnchorRect } from "./useAnchorRect";
import "./object-overlay.css";

/** Which corner an overlay is asking for. */
export type ObjectOverlayCorner =
  /** The object's own node-view element; the overlay is rendered in it. */
  | { inside: HTMLElement }
  /** An element ProseMirror owns; the overlay is measured onto the page. */
  | { over: HTMLElement };

export type ObjectOverlayPlacement = {
  /** Where the overlay is portalled. */
  container: Element;
  /** How the overlay is placed, and which half of `object-overlay.css` styles it. */
  placement: "inside" | "over";
  /** Only a measured overlay carries geometry; CSS holds the attached corner. */
  style: CSSProperties | undefined;
};

/** Matches mockup 03b: the overlay sits inside the bounds, not on the edge. */
const OVERLAY_INSET_PX = 10;

/**
 * Resolve a corner, or null when there is nothing to draw against.
 *
 * Null once the anchor has left the document: a node view that remounts leaves
 * the old element detached, and chrome rendered into a detached element is
 * chrome nobody can see or reach.
 */
export function useObjectOverlayCorner(
  editor: Editor | null,
  corner: ObjectOverlayCorner | null,
): ObjectOverlayPlacement | null {
  const measured = corner && "over" in corner ? corner.over : null;
  const rect = useAnchorRect(editor, measured);
  const overlay = manuscriptOverlay(editor);

  if (!corner || typeof document === "undefined") return null;

  if ("inside" in corner) {
    if (!corner.inside.isConnected) return null;
    return { container: corner.inside, placement: "inside", style: undefined };
  }

  if (!rect || !overlay) return null;
  return {
    container: overlay,
    placement: "over",
    // Anchored to the right edge so an overlay that gains a verb keeps its
    // outermost control where the pointer already learned to find it. The
    // class supplies the `translateX(-100%)` that pulls it back over its width.
    style: { top: rect.top + OVERLAY_INSET_PX, left: rect.right - OVERLAY_INSET_PX },
  };
}
