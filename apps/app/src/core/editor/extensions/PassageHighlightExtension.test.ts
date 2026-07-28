// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "../config";

let editor: Editor;

const marks = () => editor.view.dom.querySelectorAll("[data-passage-match]");

/** Yjs's UndoManager merges edits inside a 500ms window into one stack item. */
const settleUndoBatch = () => new Promise((resolve) => setTimeout(resolve, 600));

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const doc = new Y.Doc({ gc: false });
  editor = new Editor({
    element: document.createElement("div"),
    ...createEditorConfig({ document: doc, awareness: new Awareness(doc) }),
  });
  editor.commands.setContent({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Elara waited." }] }],
  });
});

afterEach(() => {
  editor.destroy();
  vi.unstubAllGlobals();
});

describe("PassageHighlightExtension", () => {
  it("marks the matched words without moving the writer's cursor", () => {
    const before = editor.state.selection.from;

    expect(editor.commands.showPassageMatches([{ from: 1, to: 6 }])).toBe(true);
    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.textContent).toBe("Elara");
    expect(editor.state.selection.from).toBe(before);
  });

  it("gets out of the way the moment the writer types", () => {
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);

    editor.commands.insertContentAt(14, " Then she left.");

    expect(marks()).toHaveLength(0);
  });

  it("gets out of the way when the writer moves the caret", () => {
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);

    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 10)));

    expect(marks()).toHaveLength(0);
  });

  it("gets out of the way when the writer undoes, even though Yjs signs it", () => {
    // Collaborative undo reaches ProseMirror as a ySync transaction, so its
    // metadata is the only thing separating the writer's own Ctrl+Z from a
    // peer's edit arriving.
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);

    const undo = editor.state.tr.insertText("Cold iron. ", 1);
    undo.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: true });
    editor.view.dispatch(undo);

    expect(marks()).toHaveLength(0);
  });

  it("gets out of the way on a real collaborative undo", async () => {
    editor.commands.setContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Elara waited." }] },
        { type: "paragraph", content: [{ type: "text", text: "The hall was empty." }] },
      ],
    });
    // The UndoManager batches by time, so let the seeded content settle into
    // its own stack item before the writer's edit starts a new one.
    await settleUndoBatch();
    // Edits the SECOND paragraph while the mark sits in the first, so the
    // assertion is about the undo and not about which text was replaced.
    // This pins the writer-facing outcome rather than the mechanism: today
    // y-sync's reconciliation would also map the mark away, so only the
    // metadata test below isolates the classification itself.
    editor.commands.insertContentAt(35, " Then she left.");
    await settleUndoBatch();
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);
    expect(marks()).toHaveLength(1);

    expect(editor.commands.undo()).toBe(true);

    expect(editor.state.doc.textContent).toBe("Elara waited.The hall was empty.");
    expect(marks()).toHaveLength(0);
  });

  it("survives a remote update, which is not the writer moving", () => {
    editor.commands.showPassageMatches([{ from: 1, to: 6 }]);

    const remote = editor.state.tr.insertText("Cold iron. ", 1);
    remote.setMeta(ySyncPluginKey, { isChangeOrigin: true });
    editor.view.dispatch(remote);

    expect(marks()).toHaveLength(1);
    expect(marks()[0]?.textContent).toBe("Elara");
  });
});
