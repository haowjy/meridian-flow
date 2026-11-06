/** The one impure reader of the landing walk: a `Geometry` over a live EditorView. */

import type { EditorView } from "@tiptap/pm/view";

import type { Geometry } from "./point-landing";

export function viewGeometry(view: EditorView): Geometry {
  return {
    rectOf(pos) {
      const dom = view.nodeDOM(pos);
      if (dom instanceof Element) {
        const { left, right, top, bottom } = dom.getBoundingClientRect();
        return { left, right, top, bottom };
      }
      // Text and other non-Element nodes: the caret box at the node's start.
      const { left, right, top, bottom } = view.coordsAtPos(pos);
      return { left, right, top, bottom };
    },
    focused: () => view.hasFocus(),
    inlineAt(x, y) {
      return view.posAtCoords({ left: x, top: y })?.pos ?? null;
    },
  };
}
