/** Chronological editor history across native Yjs edits and Apply boundaries. */
import type { Editor } from "@tiptap/core";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  canRedoEditorHistory,
  canUndoEditorHistory,
  DocumentHistory,
  editorHistory,
  liveAbsolutePosition,
  redoEditorHistory,
  undoEditorHistory,
} from "./editor-history";

it("preserves native history order across Apply boundaries when a remote write makes an entry a no-op", () => {
  const document = new Y.Doc();
  const text = document.getText("prose");
  const manager = new Y.UndoManager(text, { captureTimeout: 0 });
  const editor = {
    state: {
      get tr() {
        return {
          setMeta() {
            return this;
          },
        };
      },
    },
    view: { dispatch() {} },
    on() {},
    off() {},
    isDestroyed: false,
  } as unknown as Editor;
  const callbacks: string[] = [];
  const state = () => ({
    text: text.toString(),
    canUndo: canUndoEditorHistory(editor),
    canRedo: canRedoEditorHistory(editor),
    callbacks: [...callbacks],
  });

  const history = new DocumentHistory(manager);
  const detach = history.attach(editor);
  try {
    text.insert(0, "A");
    editorHistory(editor)?.captureApply({
      undo: () => callbacks.push("undo first Apply"),
      redo: () => callbacks.push("redo first Apply"),
    });
    text.insert(1, "B");
    editorHistory(editor)?.captureApply({
      undo: () => callbacks.push("undo second Apply"),
      redo: () => callbacks.push("redo second Apply"),
    });
    text.insert(2, "C");
    document.transact(() => text.delete(2, 1), "remote");

    expect(state()).toEqual({ text: "AB", canUndo: true, canRedo: false, callbacks: [] });
    for (const expected of [
      { text: "AB", canUndo: true, canRedo: false, callbacks: [] },
      { text: "AB", canUndo: true, canRedo: true, callbacks: ["undo second Apply"] },
      { text: "A", canUndo: true, canRedo: true, callbacks: ["undo second Apply"] },
      {
        text: "A",
        canUndo: true,
        canRedo: true,
        callbacks: ["undo second Apply", "undo first Apply"],
      },
      {
        text: "",
        canUndo: false,
        canRedo: true,
        callbacks: ["undo second Apply", "undo first Apply"],
      },
    ]) {
      expect(undoEditorHistory(editor)).toBe(true);
      expect(state()).toEqual(expected);
    }

    for (const expected of [
      {
        text: "A",
        canUndo: true,
        canRedo: true,
        callbacks: ["undo second Apply", "undo first Apply"],
      },
      {
        text: "A",
        canUndo: true,
        canRedo: true,
        callbacks: ["undo second Apply", "undo first Apply", "redo first Apply"],
      },
      {
        text: "AB",
        canUndo: true,
        canRedo: true,
        callbacks: ["undo second Apply", "undo first Apply", "redo first Apply"],
      },
      {
        text: "AB",
        canUndo: true,
        canRedo: false,
        callbacks: [
          "undo second Apply",
          "undo first Apply",
          "redo first Apply",
          "redo second Apply",
        ],
      },
    ]) {
      expect(redoEditorHistory(editor)).toBe(true);
      expect(state()).toEqual(expected);
    }
  } finally {
    detach();
    history.destroy();
    document.destroy();
  }
});

it("does not restore a range from a position inside a deleted paragraph", () => {
  const document = new Y.Doc();
  const fragment = document.getXmlFragment("prose");
  const first = new Y.XmlElement("paragraph");
  const firstText = new Y.XmlText("First paragraph");
  const second = new Y.XmlElement("paragraph");
  second.insert(0, [new Y.XmlText("Second")]);
  first.insert(0, [firstText]);
  fragment.insert(0, [first, second]);
  const binding = { doc: document, type: fragment, mapping: new Map() };
  const inside = Y.createRelativePositionFromTypeIndex(firstText, 3);

  expect(liveAbsolutePosition(binding, inside)).toBe(4);
  fragment.delete(0, 1);
  expect(liveAbsolutePosition(binding, inside)).toBeNull();
  document.destroy();
});

it("undoes every part of an insertion whose redone copy was split", () => {
  const document = new Y.Doc();
  const array = document.getArray<number>("array");
  const manager = new Y.UndoManager(array, { captureTimeout: 0 });

  array.insert(0, [1, 2, 3]);
  array.insert(2, [6, 7]);
  document.transact(() => {
    array.delete(1, 1);
    array.insert(1, [8]);
  });
  array.delete(0, 1);
  array.delete(1, 2);
  manager.undo();
  array.insert(2, [9]);

  for (const expected of [
    [8, 6, 7, 3],
    [1, 8, 6, 7, 3],
    [1, 2, 6, 7, 3],
    [1, 2, 3],
  ]) {
    manager.undo();
    expect(array.toJSON()).toEqual(expected);
  }

  manager.destroy();
  document.destroy();
});
