/**
 * Fixtures for the draft-review decoration and bar tests: a collaborative editor
 * with the inline-review extension, positions in it, and the model shapes the
 * server sends. Anchors are real Yjs relative positions, so every mark and
 * widget resolves the way it does in review.
 */
import type { ReviewDeletedSpan, ReviewOperation } from "@meridian/contracts/drafts";
import { Editor } from "@tiptap/core";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import type {
  InlineReviewModel,
  ResolvedReviewHunk,
  ResolvedReviewSpan,
} from "@/core/editor/extensions/inline-review/model";
import { createLocalPresence } from "@/core/editor/local-presence";
import {
  relativePositionForIndex,
  relativePositionRuntimeFromState,
} from "@/core/editor/relative-position-runtime";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";
import { createManuscriptPane } from "./standalone-editor";

const editors: Array<{ editor: Editor; pane: HTMLElement }> = [];

/** Destroy every editor `createReviewEditor` made and take its pane out of the page. */
export function destroyReviewEditors(): void {
  for (const { editor, pane } of editors.splice(0)) {
    if (!editor.isDestroyed) editor.destroy();
    pane.remove();
  }
}

/**
 * A collaborative draft-review editor over `paragraphs`, in a manuscript pane in
 * the page (chrome that measures the manuscript needs one), so anchors resolve
 * exactly as they do in review.
 */
export function createReviewEditor(paragraphs: string[]): { editor: Editor; doc: Y.Doc } {
  const doc = new Y.Doc({ gc: false });
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  doc.transact(() => {
    for (const text of paragraphs) {
      const paragraph = new Y.XmlElement("paragraph");
      const run = new Y.XmlText();
      paragraph.insert(0, [run]);
      run.insert(0, text);
      fragment.insert(fragment.length, [paragraph]);
    }
  }, "seed");
  const element = document.createElement("div");
  const pane = createManuscriptPane();
  pane.append(element);
  document.body.append(pane);
  const editor = new Editor({
    element,
    ...createEditorConfig({
      document: doc,
      presence: createLocalPresence(new Awareness(doc)),
      showCollaborationDecorations: false,
      enableDraftInlineReview: true,
    }),
  });
  editors.push({ editor, pane });
  return { editor, doc };
}

/** Absolute editor position of the first character of `needle`. */
export function posOf(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found >= 0 || !node.isText) return;
    const at = node.text?.indexOf(needle) ?? -1;
    if (at >= 0) found = pos + at;
  });
  if (found < 0) throw new Error(`"${needle}" not in document`);
  return found;
}

export function rel(editor: Editor, position: number): Y.RelativePosition {
  const runtime = relativePositionRuntimeFromState(editor.state);
  const anchor = runtime ? relativePositionForIndex(runtime, position) : null;
  if (!anchor) throw new Error("editor has no Yjs binding");
  return anchor;
}

export function operation(
  operationId: string,
  kind: "agent" | "writer",
  closureClassId = `closure:${operationId}`,
): ReviewOperation {
  return {
    operationId,
    closureClassId,
    kind,
    classification: "rewrite",
  };
}

export function span(
  editor: Editor,
  operationId: string,
  from: number,
  to: number,
): ResolvedReviewSpan {
  return { operationId, from: rel(editor, from), to: rel(editor, to) };
}

export function textHunk(
  editor: Editor,
  hunkId: string,
  operationIds: string[],
  range: { from: number; to: number },
  extra: {
    spans?: ResolvedReviewSpan[];
    deletedText?: string;
    deletedSpans?: ReviewDeletedSpan[];
    mergeArtifact?: boolean;
    unclassified?: boolean;
  } = {},
): ResolvedReviewHunk {
  return {
    kind: "text",
    hunkId,
    operationIds,
    relStart: rel(editor, range.from),
    relEnd: rel(editor, range.to),
    spans: extra.spans ?? [],
    ...(extra.deletedText ? { deletedText: extra.deletedText } : {}),
    ...(extra.deletedSpans ? { deletedSpans: extra.deletedSpans } : {}),
    ...(extra.mergeArtifact ? { mergeArtifact: true } : {}),
    ...(extra.unclassified ? { unclassified: true } : {}),
  };
}

export function model(
  operations: ReviewOperation[],
  hunks: ResolvedReviewHunk[],
): InlineReviewModel {
  return { draftRevisionToken: "1", operations, hunks };
}

export function setModel(editor: Editor, next: InlineReviewModel): void {
  editor.commands.setInlineReviewModel(next);
}
