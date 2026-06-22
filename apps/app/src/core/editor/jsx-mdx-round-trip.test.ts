/**
 * jsx-mdx-round-trip tests — verifies the app TipTap schema accepts MDX JSX
 * blocks from the shared codec and can hand them back for markdown serialization.
 *
 * @vitest-environment jsdom
 */
import { type ComponentRegistry, mdxCodec, type PMNode } from "@meridian/agent-edit";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorConfig } from "./config";

const schema = buildDocumentSchema();
const components = {
  Badge: {
    name: "Badge",
    kind: "leaf",
    children: "inline",
    props: {
      tone: { type: "string", required: true },
    },
  },
  Panel: {
    name: "Panel",
    kind: "container",
    children: "block",
    props: {
      title: { type: "string", required: true },
      meta: { type: "object" },
    },
  },
} satisfies ComponentRegistry;

const codec = mdxCodec({ schema, components });
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const destroy of cleanup.splice(0).reverse()) {
    destroy();
  }
  document.body.replaceChildren();
});

describe("JSX MDX editor round-trip", () => {
  it("preserves jsx_leaf and jsx_container through markdown to editor doc to markdown", () => {
    document.body.innerHTML = '<div id="editor"></div>';
    const markdown = [
      '<Badge tone="warn">caution text</Badge>',
      "",
      '<Panel title="Stats" meta={{"nested":{"hp":10}}}>',
      "",
      "Inside **bold** text.",
      "",
      "- item",
      "",
      "</Panel>",
    ].join("\n");
    const parsedDoc = docFrom(codec.parse(markdown).blocks);
    const editor = mountEditor();
    cleanup.push(() => editor.destroy());

    editor.commands.setContent(parsedDoc.toJSON(), { emitUpdate: true });

    const renderedHtml = editor.getHTML();
    editor.commands.setContent(renderedHtml, { emitUpdate: true });

    const editorDoc = editor.schema.nodeFromJSON(editor.getJSON());
    expect(renderedHtml).toContain('data-type="jsx_leaf"');
    expect(renderedHtml).toContain('data-type="jsx_container"');
    expect(document.querySelector("[data-type='jsx_leaf']")?.textContent).toContain("caution text");
    expect(document.querySelector("[data-type='jsx_container']")?.textContent).toContain(
      "Inside bold text.",
    );
    expect(editorDoc.toJSON()).toEqual(parsedDoc.toJSON());
    expect(editorDoc.child(0).type.name).toBe("jsx_leaf");
    expect(editorDoc.child(1).type.name).toBe("jsx_container");

    const serialized = codec.serialize(blocksOf(editorDoc));
    const reparsedDoc = docFrom(codec.parse(serialized).blocks);

    expect(reparsedDoc.toJSON()).toEqual(parsedDoc.toJSON());
    expect(serialized).toContain('<Badge tone="warn">caution text</Badge>');
    expect(serialized).toContain('<Panel meta={{"nested":{"hp":10}}} title="Stats">');
  });
});

function docFrom(blocks: readonly PMNode[]): PMNode {
  return schema.node("doc", null, blocks);
}

function blocksOf(doc: PMNode): PMNode[] {
  return [...doc.content.content];
}

function mountEditor(): Editor {
  const element = window.document.getElementById("editor");
  if (!element) throw new Error("Missing #editor");

  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  cleanup.push(() => {
    awareness.destroy();
    ydoc.destroy();
  });

  return new Editor({
    element,
    ...createEditorConfig({
      document: ydoc,
      awareness,
      showCollaborationDecorations: false,
    }),
  });
}
