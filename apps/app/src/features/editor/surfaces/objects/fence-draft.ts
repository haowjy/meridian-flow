/**
 * Editing a fence through a textarea, without eating a collaborator's words.
 *
 * A `<textarea>` reports a whole string, not an edit, so the draft diffs it
 * against the text the textarea held before the input, and writes that edit
 * only while the fence still holds exactly that text. Text a peer added since
 * the textarea last rendered was never in it: a diff against the fence would
 * read it as the writer's deletion. In that window the keystroke is dropped
 * instead; the render that shows the peer's text is already on its way.
 *
 * The fence is found through the lightbox's hold, by block id, so a peer moving
 * the diagram doesn't lose it. The textarea's selection rides the binding's
 * Loro cursors (`anchorRange`), taken while the fence and the textarea agree,
 * because a controlled textarea whose value changes puts the caret at the end.
 */

import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

import {
  anchorRange,
  carryAnchor,
  type EditorAnchor,
  type NodeHold,
  resolveAnchorIn,
  resolveNodeHold,
} from "@/core/editor/anchors";

import { isDiagramFence } from "./object-anchors";

type HeldCaret = { anchor: EditorAnchor; direction: "forward" | "backward" | "none" };

type TextPatch = { from: number; to: number; text: string };

function minimalTextPatch(current: string, next: string): TextPatch | null {
  if (current === next) return null;

  let prefix = 0;
  const shortest = Math.min(current.length, next.length);
  while (prefix < shortest && current[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    from: prefix,
    to: current.length - suffix,
    text: next.slice(prefix, next.length - suffix),
  };
}

export function useFenceDraft(
  editor: Editor,
  hold: NodeHold | null,
  source: string,
): {
  value: string;
  onChange: (next: string) => void;
  onSelect: () => void;
  area: RefObject<HTMLTextAreaElement | null>;
} {
  const area = useRef<HTMLTextAreaElement | null>(null);
  const shown = useRef(source);
  const caret = useRef<HeldCaret | null>(null);

  const fence = useCallback(() => {
    const at = hold && resolveNodeHold(editor.state, hold);
    const node = at && editor.state.doc.nodeAt(at.from);
    return node && isDiagramFence(node) ? { text: node.textContent, start: at.from + 1 } : null;
  }, [editor, hold]);

  const onSelect = useCallback(() => {
    const element = area.current;
    const found = fence();
    if (!element || !found || found.text !== element.value) return;
    caret.current = {
      anchor: anchorRange(editor.state, {
        from: found.start + element.selectionStart,
        to: found.start + element.selectionEnd,
      }),
      direction: element.selectionDirection,
    };
  }, [editor, fence]);

  useLayoutEffect(() => {
    shown.current = source;
    const element = area.current;
    const held = caret.current;
    const found = fence();
    if (!element || !held || !found || found.text !== source) return;
    const at = resolveAnchorIn(editor.state, held.anchor);
    if (!at) return;
    const offset = (pos: number) => Math.min(Math.max(pos - found.start, 0), source.length);
    element.setSelectionRange(offset(at.from), offset(at.to), held.direction);
  }, [editor, fence, source]);

  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const held = caret.current;
      if (!transaction.docChanged || !held) return;
      const anchor = carryAnchor(held.anchor, transaction.mapping);
      caret.current = anchor && { ...held, anchor };
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  const onChange = useCallback(
    (next: string) => {
      const found = fence();
      if (!found || found.text !== shown.current) return;
      const patch = minimalTextPatch(shown.current, next);
      if (!patch) return;
      editor.view.dispatch(
        editor.state.tr.insertText(patch.text, found.start + patch.from, found.start + patch.to),
      );
      shown.current = fence()?.text ?? next;
      onSelect();
    },
    [editor, fence, onSelect],
  );

  return { value: source, onChange, onSelect, area };
}
