/**
 * Editing a fence through a textarea, without eating a collaborator's words.
 *
 * A `<textarea>` reports a whole string, not an edit. Diffing that string
 * against the *current* document is wrong the moment anyone else is typing:
 * text a peer added since the pane rendered was never in the writer's textarea,
 * so the diff reads it as a deletion and the CRDT merges that faithfully. The
 * collaborator's line disappears, and nothing about the transaction says it was
 * an accident.
 *
 * So the diff runs against what the pane RENDERED — which is exactly what the
 * writer edited — and its offsets are mapped forward through every transaction
 * that has landed since, the writer's or a peer's: ProseMirror's own answer to
 * "where is that text now". A peer's write replaces only the range that
 * differs, so it maps like any other edit. The textarea's selection is carried
 * through the same mapping, since the browser puts the caret at the end
 * whenever a peer's write changes the value under it.
 *
 * The rebase resets on every render that shows new document text, so the base
 * and the mapping can never disagree about which version they describe.
 */

import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { isDiagramFence, type ObjectSurfaceTarget, objectSurfaceAt } from "./object-anchors";

type FenceRebase = {
  source: string;
  start: number;
  mapping: Mapping;
};

type FenceReading = { source: string; start: number };

/** The textarea's selection while it still shows the rendered source, in offsets into it. */
type ShownSelection = { start: number; end: number; direction: "forward" | "backward" | "none" };

function fenceRebaseAfter(
  rebase: FenceRebase,
  transaction: Transaction,
  reread: () => FenceReading | null,
): FenceRebase | null {
  const mapping = new Mapping(rebase.mapping.maps.slice());
  mapping.appendMapping(transaction.mapping);
  if (!mapping.mapResult(rebase.start).deletedAcross) return { ...rebase, mapping };
  // The binding's whole-document fallback leaves no position to map: start again from the
  // fence as it reads now, if it still holds what the pane shows.
  const fence = reread();
  return fence && fence.source === rebase.source ? { ...fence, mapping: new Mapping() } : null;
}

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

function fenceSourceTransaction(
  state: EditorState,
  rebase: FenceRebase,
  next: string,
): Transaction | null {
  const patch = minimalTextPatch(rebase.source, next);
  if (!patch) return null;

  const from = rebase.mapping.map(rebase.start + patch.from);
  // Bias the end backwards so text someone else inserted exactly at the
  // boundary stays outside the range this edit replaces.
  const to = Math.max(from, rebase.mapping.map(rebase.start + patch.to, -1));

  if (from < 0 || to > state.doc.content.size) return null;

  const $from = state.doc.resolve(from);
  if (!isDiagramFence($from.parent)) return null;
  if (from < $from.start() || to > $from.end()) return null;

  return state.tr.insertText(patch.text, from, to);
}

export function useFenceDraft(
  editor: Editor,
  target: ObjectSurfaceTarget | null,
): {
  value: string;
  onChange: (next: string) => void;
  area: RefObject<HTMLTextAreaElement | null>;
} {
  const source = target?.node.textContent ?? "";
  const start = target ? target.pos + 1 : 0;

  const targetRef = useRef(target);
  targetRef.current = target;
  const area = useRef<HTMLTextAreaElement | null>(null);
  const rebaseRef = useRef<FenceRebase | null>({ source, start, mapping: new Mapping() });
  const shownRef = useRef<ShownSelection | null>(null);

  // Showing new document text means everything up to it is now the base and
  // nothing has happened since. Layout phase, so a keystroke in the same frame
  // cannot land against a half-updated rebase, and the selection is back
  // before the writer sees the caret anywhere else.
  useLayoutEffect(() => {
    const shown = shownRef.current;
    const rebase = rebaseRef.current;
    shownRef.current = null;
    if (shown && rebase && area.current) {
      const at = (offset: number) => {
        const pos = rebase.mapping.map(rebase.start + offset, -1) - start;
        return Math.min(Math.max(pos, 0), source.length);
      };
      area.current.setSelectionRange(at(shown.start), at(shown.end), shown.direction);
    }
    rebaseRef.current = { source, start, mapping: new Mapping() };
  }, [source, start]);

  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const rebase = rebaseRef.current;
      if (!transaction.docChanged || !rebase) return;
      // The writer's own keystroke leaves the textarea holding its new text, with the caret
      // where the browser put it; any other write changes the value under it.
      const element = area.current;
      shownRef.current =
        element && element.value === rebase.source
          ? {
              start: element.selectionStart,
              end: element.selectionEnd,
              direction: element.selectionDirection,
            }
          : null;
      rebaseRef.current = fenceRebaseAfter(rebase, transaction, () =>
        readFence(editor, targetRef.current?.element),
      );
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
    };
  }, [editor]);

  const onChange = useCallback(
    (next: string) => {
      const rebase = rebaseRef.current;
      const transaction = rebase && fenceSourceTransaction(editor.state, rebase, next);
      if (!transaction) return;
      editor.view.dispatch(transaction);

      // Read the base back from the document rather than trusting `next`: the
      // merge may have produced something else, and the next keystroke has to
      // diff against what the writer is about to see. This also closes the
      // window between the dispatch and the render that would rebase anyway.
      const after = readFence(editor, targetRef.current?.element);
      rebaseRef.current = after && { ...after, mapping: new Mapping() };
    },
    [editor],
  );

  return { value: source, onChange, area };
}

function readFence(editor: Editor, element: HTMLElement | undefined): FenceReading | null {
  const found = element ? objectSurfaceAt(editor.view, element) : null;
  return found && { source: found.node.textContent, start: found.pos + 1 };
}
