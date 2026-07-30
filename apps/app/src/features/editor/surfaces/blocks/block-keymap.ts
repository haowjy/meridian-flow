/**
 * Alt+↑/↓ (§4, §5.8): the keyboard twin of the drag, registered at the kernel's
 * `block` scope.
 *
 * Scope is the whole precedence story. Inside a table the same keys move rows,
 * and rows belong to the table surface at the deeper `table` scope — so this
 * binding also declines outright when the caret is in a cell, rather than
 * moving the table out from under a writer editing one square of it. A
 * selected table is a different question and still moves: it is an object, and
 * the writer selected the whole thing.
 *
 * Its own module because it changes for its own reasons: which keys the lane
 * claims and where they sit in the ladder, never pointer capture or paint.
 */

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

/**
 * Registered under the surface's own id, which the surface owns and hands over:
 * one lane answers Alt+Arrow, whichever of its doors the writer came through.
 */
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
        // The ends of the document are a no-op, and an unconsumed one: the key
        // is left for whatever else might want it rather than swallowed here.
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
