/**
 * What a React surface aims at while it is open: a node, held.
 *
 * Every surface that outlives a keystroke needs the same three things, and the
 * plumbing is the same three lines every time — take hold of a node, carry the
 * hold through every change to the document, let go once the node is gone. This
 * is that plumbing, once, so a lane's own file is about its surface.
 *
 * **Elements are geometry, holds are identity.** A node view is replaced by
 * any write that covers it, so an element read this frame is the right way to measure
 * where something is drawn and the wrong way to remember what it was. Resolve a
 * hold to a position and that position to DOM at the moment of measuring, or of
 * running a verb, and never the other way around.
 *
 * The identity of the returned hold changes only when the held node moves, so a
 * surface may depend on it in an effect: re-pinning a node nothing touched
 * answers with the hold already held.
 */

import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import {
  followHold,
  type HoldResolver,
  holdNode,
  type NodeHold,
  resolveNodeHold,
  sameHold,
} from "@/core/editor/anchors";

export type TakeNodeHold = (pos: number | null) => void;

export function useNodeHold(
  editor: Editor,
  resolve: HoldResolver = resolveNodeHold,
): [NodeHold | null, TakeNodeHold] {
  const [hold, setHold] = useState<NodeHold | null>(null);

  useDocumentMapping(editor, (mapping) => {
    setHold((current) => {
      if (current === null) return null;
      const next = followHold(editor.state, current, mapping, resolve);
      return sameHold(current, next) ? current : next;
    });
  });

  const take = useCallback<TakeNodeHold>(
    (pos) => {
      const held = pos === null || editor.isDestroyed ? null : holdNode(editor.state, pos);
      const next = held && resolve(editor.state, held) ? held : null;
      setHold((current) => (sameHold(current, next) ? current : next));
    },
    [editor, resolve],
  );

  return [hold, take];
}

export function useHeldAnchor<Anchor>(
  editor: Editor,
  initial: Anchor | null,
  follow: (state: EditorState, anchor: Anchor, mapping: Mappable) => Anchor | null,
  onLost?: () => void,
): RefObject<Anchor | null> {
  const held = useRef(initial);
  useDocumentMapping(editor, (mapping) => {
    if (held.current === null) return;
    held.current = follow(editor.state, held.current, mapping);
    if (held.current === null) onLost?.();
  });
  return held;
}

function useDocumentMapping(editor: Editor, onMapping: (mapping: Mappable) => void): void {
  const latest = useRef(onMapping);
  latest.current = onMapping;

  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!transaction.docChanged || editor.isDestroyed) return;
      latest.current(transaction.mapping);
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);
}
