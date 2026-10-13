/**
 * The manuscript's text column in the overlay's coordinates: where its content
 * ends on the right and how wide the pane is, which is all the room the bar
 * has beside the text. Re-measured when the pane or the column resizes.
 */
import type { Editor } from "@tiptap/core";
import { useLayoutEffect, useState } from "react";

import { watchManuscriptLayout } from "@/core/editor/chrome";

import { manuscriptOverlay, overlayRect } from "../../chrome/manuscript-overlay";

export type ManuscriptColumn = { columnRight: number; paneWidth: number };

export function useManuscriptColumn(editor: Editor, enabled: boolean): ManuscriptColumn | null {
  const [column, setColumn] = useState<ManuscriptColumn | null>(null);

  useLayoutEffect(() => {
    if (!enabled || editor.isDestroyed) {
      setColumn(null);
      return;
    }
    const measure = () => {
      const overlay = manuscriptOverlay(editor);
      const box = overlay && overlayRect(overlay, editor.view.dom);
      if (!overlay || !box) {
        setColumn(null);
        return;
      }
      const padding = Number.parseFloat(getComputedStyle(editor.view.dom).paddingRight) || 0;
      const next = { columnRight: box.right - padding, paneWidth: overlay.clientWidth };
      setColumn((previous) =>
        previous &&
        previous.columnRight === next.columnRight &&
        previous.paneWidth === next.paneWidth
          ? previous
          : next,
      );
    };
    measure();
    return watchManuscriptLayout(editor, [manuscriptOverlay(editor)], measure);
  }, [editor, enabled]);

  return column;
}
