import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";

import { watchManuscriptLayout } from "@/core/editor/chrome";

import { manuscriptOverlay, type OverlayBox, overlayRect } from "./manuscript-overlay";

export type AnchorRect = OverlayBox;

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
