import type { Editor } from "@tiptap/core";
import { useEffect } from "react";

import type { KeymapBinding } from "@/core/editor/chrome";

import { useEditorChrome } from "../../chrome/useEditorChrome";
import {
  type BlockMoveDirection,
  blockForSelection,
  moveBlockStepTransaction,
  selectionIsInsideTable,
} from "./block-targets";

export function useBlockMovementKeymap(editor: Editor, surfaceId: string): void {
  const chrome = useEditorChrome(editor);

  useEffect(() => {
    if (!chrome) return;

    const move =
      (direction: BlockMoveDirection): KeymapBinding =>
      (state, dispatch) => {
        if (selectionIsInsideTable(state)) return false;
        const source = blockForSelection(state);
        if (!source) return false;
        const transaction = moveBlockStepTransaction(state, source, direction);
        if (!transaction) return false;
        dispatch?.(transaction);
        return true;
      };

    return chrome.registerKeymap({
      id: surfaceId,
      scope: "block",
      bindings: { "Alt-ArrowUp": move("up"), "Alt-ArrowDown": move("down") },
    });
  }, [chrome, surfaceId]);
}
