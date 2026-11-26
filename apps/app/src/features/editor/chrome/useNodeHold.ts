import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { useCallback, useEffect, useState } from "react";

import { followNode, holdNode, type NodeHold, sameHold } from "@/core/editor/anchors";

export type TakeNodeHold = (pos: number | null) => void;

export function useNodeHold(editor: Editor): [NodeHold | null, TakeNodeHold] {
  const [hold, setHold] = useState<NodeHold | null>(null);

  // A peer's write, an AI write, and the writer's own typing all move the held
  // node, and only the transaction carries the mapping a document with no room
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
