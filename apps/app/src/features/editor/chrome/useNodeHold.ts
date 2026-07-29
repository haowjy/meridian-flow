/**
 * What a React surface aims at while it is open: a node, held.
 *
 * Every surface that outlives a keystroke needs the same three things, and the
 * plumbing is the same three lines every time — take hold of a node, carry the
 * hold through every change to the document, let go once the node is gone. This
 * is that plumbing, once, so a lane's own file is about its surface.
 *
 * **Elements are geometry, holds are identity.** A node view is replaced by
 * every remote write, so an element read this frame is the right way to measure
 * where something is drawn and the wrong way to remember what it was. Resolve a
 * hold to a position and that position to DOM at the moment of measuring, or of
 * running a verb, and never the other way around.
 *
 * The identity of the returned hold changes only when the held node moves, so a
 * surface may depend on it in an effect: re-pinning a node nothing touched
 * answers with the hold already held.
 */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useCallback, useEffect, useState } from "react";

import { followNode, holdNode, type NodeHold, sameHold } from "@/core/editor/anchors";

/** `null` lets go; a position takes hold of whatever node starts there. */
export type TakeNodeHold = (pos: number | null) => void;

export function useNodeHold(editor: Editor): [NodeHold | null, TakeNodeHold] {
  const [hold, setHold] = useState<NodeHold | null>(null);

  // A peer's write, an AI write, and the writer's own typing all move the held
  // node, and only the transaction carries the mapping a document with no Yjs
  // behind it needs. A hold that resolves to nothing is released here rather
  // than left for the render to notice: state a surface keeps for a node that
  // is gone is how a menu reopens on the wrong block later.
  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || editor.isDestroyed) return;
      setHold((current) => {
        if (current === null) return null;
        const next = followNode(editor.state, current, transaction.mapping);
        return sameHold(current, next) ? current : next;
      });
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  const take = useCallback<TakeNodeHold>(
    (pos) => {
      setHold((current) => {
        if (pos === null) return null;
        const next = editor.isDestroyed ? null : holdNode(editor.state, pos);
        return sameHold(current, next) ? current : next;
      });
    },
    [editor],
  );

  return [hold, take];
}
