import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";

import { watchManuscriptLayout } from "@/core/editor/chrome";

import { manuscriptOverlay, type OverlayBox, overlayRect } from "./manuscript-overlay";

export type AnchorRect = OverlayBox;

/**
 * The anchor's box in the overlay's coordinates, followed while the caller is
 * mounted.
 *
 * Null once the anchor has left the document: a node view that remounts leaves
 * the old element detached, and a detached element measures as a zero box in
 * the page's top-left corner. Reporting no rect takes the surface off the page
 * instead, which is the honest answer — the thing it decorated is gone — and
 * keeps an opaque overlay from taking clicks in a corner it never belonged in.
 *
 * Measurement is rAF-coalesced and the state is identity-stable, so a reflow
 * or a keystroke that does not move this anchor costs no render.
 */
export function useAnchorRect(
  editor: Editor | null,
  anchor: HTMLElement | null,
): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null);

  useLayoutEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }

    const measure = () => {
      const overlay = manuscriptOverlay(editor);
      const box = overlay && overlayRect(overlay, anchor);
      setRect((previous) => {
        if (!box) return null;
        return previous && sameRect(previous, box) ? previous : box;
      });
    };

    measure();
    return watchManuscriptLayout(editor, [anchor], measure);
  }, [anchor, editor]);

  return rect;
}

function sameRect(rect: AnchorRect, box: AnchorRect): boolean {
  return (
    rect.top === box.top &&
    rect.right === box.right &&
    rect.bottom === box.bottom &&
    rect.left === box.left
  );
}
