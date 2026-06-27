/**
 * editor config tests — runtime guards for the TipTap editor option factory.
 *
 * TipTap v3 does not tolerate `editorProps: undefined`; this test mounts real
 * editors so the factory stays compatible with the runtime collaboration path.
 *
 * @vitest-environment jsdom
 */

import type { YjsTrackedSchemaType } from "@meridian/contracts/protocol";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { createEditorConfig } from "./config";

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const destroy of cleanup.splice(0).reverse()) {
    destroy();
  }
  document.body.replaceChildren();
});

describe("createEditorConfig", () => {
  it("mounts TipTap v3 collaboration editors without explicit editorProps", () => {
    document.body.innerHTML = '<div id="editor-a"></div><div id="editor-b"></div>';

    const ydoc = new Y.Doc();
    const awarenessA = new Awareness(ydoc);
    const awarenessB = new Awareness(ydoc);
    cleanup.push(() => {
      awarenessA.destroy();
      awarenessB.destroy();
      ydoc.destroy();
    });

    const editorA = mountEditor("editor-a", ydoc, awarenessA);
    const editorB = mountEditor("editor-b", ydoc, awarenessB);
    cleanup.push(
      () => editorA.destroy(),
      () => editorB.destroy(),
    );

    const marker = `TipTap v3 sync ${Date.now()}`;
    editorA.commands.insertContent({
      type: "paragraph",
      content: [{ type: "text", text: marker }],
    });

    expect(editorA.getText()).toContain(marker);
    expect(editorB.getText()).toContain(marker);
  });

  it("does not append StarterKit's v3 trailing paragraph to shared content", () => {
    document.body.innerHTML = '<div id="editor"></div>';

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    cleanup.push(() => {
      awareness.destroy();
      ydoc.destroy();
    });

    const editor = mountEditor("editor", ydoc, awareness);
    cleanup.push(() => editor.destroy());

    editor.commands.setContent(
      {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 1 },
            content: [{ type: "text", text: "Heading-only document" }],
          },
        ],
      },
      { emitUpdate: true },
    );

    expect(editor.getJSON().content?.map((node) => node.type)).toEqual(["heading"]);
  });

  // Guards the list_item rename: TipTap's list commands default to itemTypeName
  // "listItem", but our schema renames it to "list_item". Without the configured
  // itemTypeName, toggleBulletList/toggleOrderedList throw "no node type named
  // 'listItem'" and the toolbar list buttons silently fail.
  it("toggles bullet and ordered lists with the renamed list_item type", () => {
    document.body.innerHTML = '<div id="editor"></div>';

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    cleanup.push(() => {
      awareness.destroy();
      ydoc.destroy();
    });

    const editor = mountEditor("editor", ydoc, awareness);
    cleanup.push(() => editor.destroy());

    editor.commands.setContent(
      { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "item" }] }] },
      { emitUpdate: true },
    );

    editor.commands.selectAll();
    expect(() => editor.commands.toggleBulletList()).not.toThrow();
    expect(nodeTypes(editor)).toContain("bullet_list");
    expect(nodeTypes(editor)).toContain("list_item");

    editor.commands.selectAll();
    expect(() => editor.commands.toggleOrderedList()).not.toThrow();
    expect(nodeTypes(editor)).toContain("ordered_list");
  });

  it("pastes markdown tables as closed block slices without merging paragraph text into cells", () => {
    document.body.innerHTML = '<div id="editor"></div>';

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    cleanup.push(() => {
      awareness.destroy();
      ydoc.destroy();
    });

    const editor = mountEditor("editor", ydoc, awareness);
    cleanup.push(() => editor.destroy());

    editor.commands.setContent(
      {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "hello world" }] }],
      },
      { emitUpdate: true },
    );
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, "hello".length + 1)),
    );

    const parser = editor.options.editorProps?.clipboardTextParser;
    if (!parser) throw new Error("expected document editor clipboardTextParser");

    const slice = parser(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      editor.state.selection.$from,
      false,
      editor.view,
    );
    if (!slice) throw new Error("expected markdown table slice");

    editor.view.dispatch(editor.state.tr.replaceSelection(slice));

    expect(nodeTypes(editor)).toContain("table");
    expect(paragraphTexts(editor).join("\n")).toContain("hello");
    expect(paragraphTexts(editor).join("\n")).toContain("world");
    expect(tableCellTexts(editor).join("\n")).not.toContain("hello");
    expect(tableCellTexts(editor).join("\n")).not.toContain("world");
  });

  it("does not install the markdown-table clipboard parser for code editors", () => {
    document.body.innerHTML = '<div id="editor"></div>';

    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    cleanup.push(() => {
      awareness.destroy();
      ydoc.destroy();
    });

    const editor = mountEditor("editor", ydoc, awareness, { schemaType: "code" });
    cleanup.push(() => editor.destroy());

    expect(editor.options.editorProps?.clipboardTextParser).toBeUndefined();
  });
});

function nodeTypes(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.descendants((node) => {
    types.push(node.type.name);
  });
  return types;
}

function paragraphTexts(editor: Editor): string[] {
  return textsForNodeType(editor, "paragraph");
}

function tableCellTexts(editor: Editor): string[] {
  return textsForNodeType(editor, "table_cell").concat(textsForNodeType(editor, "table_header"));
}

function textsForNodeType(editor: Editor, typeName: string): string[] {
  const texts: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === typeName) texts.push(node.textContent);
  });
  return texts;
}

function mountEditor(
  id: string,
  document: Y.Doc,
  awareness: Awareness,
  options: { schemaType?: YjsTrackedSchemaType } = {},
): Editor {
  const element = window.document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);

  return new Editor({
    element,
    ...createEditorConfig({
      document,
      awareness,
      schemaType: options.schemaType,
      showCollaborationDecorations: false,
    }),
  });
}
