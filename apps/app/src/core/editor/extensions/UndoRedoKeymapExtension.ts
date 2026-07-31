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
  // Above the collaboration extension's own 1000, so these keys resolve here
  // first and no extension added later can quietly take them.
  priority: 1100,

  // Every binding consumes its key whether or not the stack had anything left.
  // Ownership that lapses on an empty stack is not ownership: the key would
  // fall through to the collaboration extension's own binding and then to the
  // browser, and a writer at the bottom of their history would find Mod-z
  // doing whatever the page does.
  addKeyboardShortcuts() {
    return {
      "Mod-z": () => {
        this.editor.commands.undo();
        return true;
      },
      "Mod-y": () => {
        this.editor.commands.redo();
        return true;
      },
      "Shift-Mod-z": () => {
        this.editor.commands.redo();
        return true;
      },
    };
  },
});
