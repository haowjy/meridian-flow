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
 * writer edited — and its offsets are mapped forward through every LOCAL
 * transaction that has landed since, ProseMirror's own answer to "where is
 * that text now". With nobody else typing the mapping is empty and this is one
 * `insertText`.
 *
 * A peer's write is the case the mapping cannot answer: it arrives as one
 * replacement over everything that differs, so an offset inside it maps to its
 * edge. The document is re-read instead, and when the fence itself changed underneath
 * the writer the pane has no usable base at all until the next render supplies
 * one — refusing there is what keeps the diff from reading the peer's new line
 * as the writer's deletion.
 *
 * The rebase resets on every render that shows new document text, so the base
 * and the mapping can never disagree about which version they describe.
 */

import type { Editor } from "@tiptap/core";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Mapping } from "@tiptap/pm/transform";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { isRemoteEdit } from "@/core/editor/anchors";

import { isDiagramFence, type ObjectSurfaceTarget, objectSurfaceAt } from "./object-anchors";

export type FenceRebase = {
  source: string;
  start: number;
  mapping: Mapping;
};

export function fenceRebaseAfter(rebase: FenceRebase, transaction: Transaction): FenceRebase {
  const mapping = new Mapping(rebase.mapping.maps.slice());
  mapping.appendMapping(transaction.mapping);
  return { ...rebase, mapping };
}

export type FenceReading = { source: string; start: number };

export function fenceRebaseAfterRemote(
  rebase: FenceRebase,
  fence: FenceReading | null,
): FenceRebase | null {
  if (!fence || fence.source !== rebase.source) return null;
  return { ...fence, mapping: new Mapping() };
}

export type TextPatch = { from: number; to: number; text: string };

export function minimalTextPatch(current: string, next: string): TextPatch | null {
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

export function fenceSourceTransaction(
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
): { value: string; onChange: (next: string) => void } {
  const source = target?.node.textContent ?? "";
  const start = target ? target.pos + 1 : 0;

  const targetRef = useRef(target);
  targetRef.current = target;
  const rebaseRef = useRef<FenceRebase | null>({ source, start, mapping: new Mapping() });

  // Showing new document text means everything up to it is now the base and
  // nothing has happened since. Layout phase, so a keystroke in the same frame
  // cannot land against a half-updated rebase.
  useLayoutEffect(() => {
    rebaseRef.current = { source, start, mapping: new Mapping() };
  }, [source, start]);

  useEffect(() => {
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      const rebase = rebaseRef.current;
      if (!transaction.docChanged || !rebase) return;
      rebaseRef.current = isRemoteEdit(transaction)
        ? fenceRebaseAfterRemote(rebase, readFence(editor, targetRef.current?.element))
        : fenceRebaseAfter(rebase, transaction);
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

  return { value: source, onChange };
}

function readFence(editor: Editor, element: HTMLElement | undefined): FenceReading | null {
  const found = element ? objectSurfaceAt(editor.view, element) : null;
  return found && { source: found.node.textContent, start: found.pos + 1 };
}
