import { Extension } from "@tiptap/core";
import { type DocumentHistory, redoEditorHistory, undoEditorHistory } from "../editor-history";
import { KEYMAP_PRIORITY } from "../keymap-priority";

export const UndoRedoKeymapExtension = Extension.create({
  name: "meridianUndoRedoKeymap",
  priority: KEYMAP_PRIORITY.undoRedo,

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
