/** Chronological editor history across native Yjs edits and Apply boundaries. */
import type { Editor } from "@tiptap/core";
import { yUndoPluginKey } from "@tiptap/y-tiptap";
import { expect, it } from "vitest";
import * as Y from "yjs";
import {
  canRedoEditorHistory,
  canUndoEditorHistory,
  editorHistory,
  mountEditorHistory,
  redoEditorHistory,
  undoEditorHistory,
  unmountEditorHistory,
} from "./editor-history";

it("preserves native history order across Apply boundaries when a remote write makes an entry a no-op", () => {
  const document = new Y.Doc();
  const text = document.getText("prose");
  const manager = new Y.UndoManager(text, { captureTimeout: 0 });
  const pluginKey = (yUndoPluginKey as unknown as { key: string }).key;
  const editor = {
    state: {
      [pluginKey]: { undoManager: manager },
      get tr() {
        return {
          setMeta() {
            return this;
          },
        };
      },
    },
    view: { dispatch() {} },
    isDestroyed: false,
  } as unknown as Editor;
  const callbacks: string[] = [];
  const state = () => ({
    text: text.toString(),
    canUndo: canUndoEditorHistory(editor),
    canRedo: canRedoEditorHistory(editor),
    callbacks: [...callbacks],
  });

  try {
    mountEditorHistory(editor);
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
    unmountEditorHistory(editor);
    manager.destroy();
    document.destroy();
  }
});
