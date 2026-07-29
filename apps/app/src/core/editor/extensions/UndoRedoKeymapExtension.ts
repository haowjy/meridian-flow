/**
 * The editor owns Mod-z / Mod-y / Mod-Shift-z.
 *
 * The history itself is the Yjs UndoManager behind
 * `@tiptap/extension-collaboration`, which also ships these bindings. Meridian
 * binds them itself, at a priority above every other extension, because undo is
 * the writer's recovery over LLM writes (ruling 17, R1): the keys are a named
 * part of the editor rather than a default inherited from a dependency that
 * another extension's keymap could shadow. Mount it only where collaborative
 * history exists — a standalone editor has no undo command to bind to.
 */
import { Extension } from "@tiptap/core";

export const UndoRedoKeymapExtension = Extension.create({
  name: "meridianUndoRedoKeymap",
  priority: 1000,

  addKeyboardShortcuts() {
    return {
      "Mod-z": () => this.editor.commands.undo(),
      "Mod-y": () => this.editor.commands.redo(),
      "Shift-Mod-z": () => this.editor.commands.redo(),
    };
  },
});
