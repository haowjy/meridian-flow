// @vitest-environment jsdom
/** Editor configuration contracts at live-versus-review composition boundaries. */

import { Editor, getSchema } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig, createStandaloneEditorExtensions } from "./config";
import { createLocalPresence } from "./local-presence";

function keyboardShortcutsOf(extensions: ReturnType<typeof createStandaloneEditorExtensions>) {
  return extensions.flatMap((extension) => {
    const shortcuts = extension.config.addKeyboardShortcuts;
    return typeof shortcuts === "function"
      ? [{ name: extension.name, priority: extension.config.priority ?? 100 }]
      : [];
  });
}

describe("createEditorConfig", () => {
  it("keeps a draft review editor editable — the writer is one more peer in the draft room", () => {
    const document = new Y.Doc();

    const config = createEditorConfig({
      document,
      presence: createLocalPresence(new Awareness(document)),
      editable: true,
      enableDraftInlineReview: true,
    });

    expect(config.editable).toBe(true);
  });
});

describe("undo ownership", () => {
  it("binds the collaborative history keys above every inherited keymap", () => {
    const document = new Y.Doc();
    const config = createEditorConfig({
      document,
      presence: createLocalPresence(new Awareness(document)),
    });
    const shortcuts = keyboardShortcutsOf(config.extensions ?? []);
    const owned = shortcuts.find((entry) => entry.name === "meridianUndoRedoKeymap");

    // Undo is the writer's recovery over LLM writes: the keys are Meridian's,
    // not the collaboration extension's to hand out (ruling 17).
    expect(owned).toBeDefined();
    for (const other of shortcuts) {
      if (other.name !== "meridianUndoRedoKeymap") {
        expect(owned?.priority).toBeGreaterThan(other.priority);
      }
    }
  });
});

describe("inline code keyboard home", () => {
  it("toggles the code mark on Mod-e", () => {
    // The toolbar's Code button is a code-block toggle (human ruling), so the
    // inline mark's only writer surface until the formatting menu lands is
    // this binding. TipTap's Code extension owns it; the schema-parity rename
    // to `code` must not have cost us the shortcut.
    const editor = new Editor({
      extensions: createStandaloneEditorExtensions(),
      content: "<p>the third gate</p>",
    });
    editor.commands.setTextSelection({ from: 5, to: 15 });

    const handled = editor.view.someProp("handleKeyDown", (handler) =>
      handler(
        editor.view,
        new KeyboardEvent("keydown", { key: "e", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );

    expect(handled).toBe(true);
    expect(editor.isActive("code")).toBe(true);
    editor.destroy();
  });
});

describe("editor block layout schema", () => {
  it("exposes nullable align attrs on each alignable block", () => {
    const schema = getSchema(createStandaloneEditorExtensions());

    for (const nodeName of ["paragraph", "heading", "table"]) {
      expect(schema.nodes[nodeName]?.create().attrs.align).toBeNull();
    }
  });
});

describe("editor paste configuration", () => {
  it("sanitizes the final HTML after composing a caller transform", () => {
    const document = new Y.Doc();
    const config = createEditorConfig({
      document,
      presence: createLocalPresence(new Awareness(document)),
      editorProps: {
        transformPastedHTML: () => '<p onclick="alert(1)">safe</p><script>bad()</script>',
      },
    });

    const transform = config.editorProps?.transformPastedHTML;
    expect(transform).toBeDefined();
    expect(transform?.call(null, "ignored", {} as EditorView)).toBe("<p>safe</p>");
  });
});
