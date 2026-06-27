/**
 * editor config tests — runtime guards for the TipTap editor option factory.
 *
 * TipTap v3 does not tolerate `editorProps: undefined`; this test mounts real
 * editors so the factory stays compatible with the runtime collaboration path.
 *
 * @vitest-environment jsdom
 */

import { Editor } from "@tiptap/core";
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
});

function nodeTypes(editor: Editor): string[] {
  const types: string[] = [];
  editor.state.doc.descendants((node) => {
    types.push(node.type.name);
  });
  return types;
}

function mountEditor(id: string, document: Y.Doc, awareness: Awareness): Editor {
  const element = window.document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);

  return new Editor({
    element,
    ...createEditorConfig({
      document,
      awareness,
      showCollaborationDecorations: false,
    }),
  });
}
