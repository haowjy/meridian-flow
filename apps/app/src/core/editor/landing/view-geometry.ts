/** The one impure reader of the landing walk: a `Geometry` over a live EditorView. */

import type { EditorView } from "@tiptap/pm/view";

import type { Geometry } from "./point-landing";

export function viewGeometry(view: EditorView): Geometry {
  return {
    rectOf(pos) {
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof Element)) return null;
      const { left, right, top, bottom } = dom.getBoundingClientRect();
      return { left, right, top, bottom };
    },
    inlineAt(x, y) {
      return view.posAtCoords({ left: x, top: y })?.pos ?? null;
    },
  };
}
