import { Extension } from "@tiptap/core";
import { type DocumentHistory, redoEditorHistory, undoEditorHistory } from "../editor-history";

export const UndoRedoKeymapExtension = Extension.create({
  name: "meridianUndoRedoKeymap",
  // Above every other extension's priority, so these keys resolve here first and no
  // extension added later can quietly take them.
  priority: 1100,

  addOptions() {
    return { history: null as DocumentHistory | null };
  },

  addStorage() {
    return { detach: null as (() => void) | null };
  },

  onCreate() {
    this.storage.detach = this.options.history?.attach(this.editor) ?? null;
  },

  onDestroy() {
    this.storage.detach?.();
    this.storage.detach = null;
  },

  // Every binding consumes its key whether or not the stack had anything left.
  // Ownership that lapses on an empty stack is not ownership: the key would
  // fall through to the browser, and a writer at the bottom of their history
  // would find Mod-z doing whatever the page does.
  addKeyboardShortcuts() {
    return {
      "Mod-z": () => {
        undoEditorHistory(this.editor);
        return true;
      },
      "Mod-y": () => {
        redoEditorHistory(this.editor);
        return true;
      },
      "Shift-Mod-z": () => {
        redoEditorHistory(this.editor);
        return true;
      },
    };
  },
});
