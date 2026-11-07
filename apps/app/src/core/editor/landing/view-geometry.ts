/** The one impure reader of the landing walk: a `Geometry` over a live EditorView. */

import type { Editor } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";

import type { Geometry } from "./point-landing";

/** The box of the node starting at `pos`. */
function nodeRect(view: EditorView): Geometry["rectOf"] {
  return (pos) => {
    const dom = view.nodeDOM(pos);
    if (dom instanceof Element) {
      const { left, right, top, bottom } = dom.getBoundingClientRect();
      return { left, right, top, bottom };
    }
    // Text and other non-Element nodes: the caret box at the node's start.
    const { left, right, top, bottom } = view.coordsAtPos(pos);
    return { left, right, top, bottom };
  };
}

/** Focus reads `editor.isFocused`, the same answer the diagram's node view draws from. */
export function viewGeometry(view: EditorView, editor: Editor): Geometry {
  return {
    rectOf: nodeRect(view),
    focused: () => editor.isFocused,
    inlineAt(x, y) {
      return view.posAtCoords({ left: x, top: y })?.pos ?? null;
    },
  };
}
