/**
 * Fixtures for the draft-review decoration and bar tests: a collaborative editor
 * with the inline-review extension, a seeded `review_base`, and the projector
 * that paints the review exactly as the app does.
 */
import { REVIEW_BASE_FRAGMENT } from "@meridian/agent-edit/diff";
import { Editor } from "@tiptap/core";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "@/core/editor/config";
import { createLocalPresence } from "@/core/editor/local-presence";
import { PROSEMIRROR_FRAGMENT_NAME } from "@/core/editor/schema";
import { createReviewRuntime, type ReviewRuntime } from "@/features/draft-review/review-runtime";
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
export function createReviewEditor(
  paragraphs: string[],
  /** A room another editor is already bound to: bind to it unseeded, as the dock and the Editor tab do. */
  sharedDoc?: Y.Doc,
): { editor: Editor; doc: Y.Doc } {
  const doc = sharedDoc ?? new Y.Doc({ gc: false });
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  if (!sharedDoc) {
    doc.transact(() => {
      for (const text of paragraphs) {
        const paragraph = new Y.XmlElement("paragraph");
        const run = new Y.XmlText();
        paragraph.insert(0, [run]);
        run.insert(0, text);
        fragment.insert(fragment.length, [paragraph]);
      }
    }, "seed");
  }
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

/** Write `paragraphs` into the draft room's `review_base` root, as the server's rebase writer would. */
export function seedReviewBase(doc: Y.Doc, paragraphs: string[]): void {
  const fragment = doc.getXmlFragment(REVIEW_BASE_FRAGMENT);
  doc.transact(() => {
    fragment.delete(0, fragment.length);
    for (const text of paragraphs) {
      const paragraph = new Y.XmlElement("paragraph");
      const run = new Y.XmlText();
      paragraph.insert(0, [run]);
      run.insert(0, text);
      fragment.insert(fragment.length, [paragraph]);
    }
  }, "seed-base");
}

/** A draft room that is already synced and holds no local edits: enough for a runtime to read. */
function syncedRoom(doc: Y.Doc) {
  return {
    document: doc,
    subscribe: () => () => {},
    getSnapshot: () => ({ status: "synced" }) as never,
    whenSynced: () => Promise.resolve(),
    hasUnacknowledgedEdits: () => false,
  };
}

/** The one review runtime of the draft room `doc`; every editor on the room attaches to it, as a tab and the dock do. */
export function createRoomRuntime(doc: Y.Doc): ReviewRuntime {
  return createReviewRuntime(syncedRoom(doc));
}

/** A fresh runtime of `doc` with `editor` attached: it projects the editor's text and paints it, as the app does. */
export function attachReviewRuntime(editor: Editor, doc: Y.Doc): ReviewRuntime {
  const runtime = createRoomRuntime(doc);
  runtime.attachEditor(editor);
  return runtime;
}
