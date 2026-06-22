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
    const renderedBadge = renderedComponent(renderedHtml, "Badge");
    const renderedPanel = renderedComponent(renderedHtml, "Panel");
    expect(propNamesFromElement(renderedBadge)).toEqual(["tone"]);
    expect(propNamesFromElement(renderedPanel)).toEqual(["meta", "title"]);
    expect(renderedBadge.textContent).toContain("caution text");
    expect(renderedPanel.textContent).toContain("Inside bold text.");
    expect(editorDoc.toJSON()).toEqual(parsedDoc.toJSON());
    expect(editorDoc.child(0).type.name).toBe("jsx_leaf");
    expect(editorDoc.child(1).type.name).toBe("jsx_container");

    const serialized = codec.serialize(blocksOf(editorDoc));
    const reparsedDoc = docFrom(codec.parse(serialized).blocks);

    expect(reparsedDoc.toJSON()).toEqual(parsedDoc.toJSON());
    const reparsedBadge = reparsedDoc.child(0);
    const reparsedPanel = reparsedDoc.child(1);
    expectJsxComponent(reparsedBadge, {
      type: "jsx_leaf",
      name: "Badge",
      propNames: ["tone"],
    });
    expect(propsOf(reparsedBadge)).toMatchObject({ tone: "warn" });
    expectJsxComponent(reparsedPanel, {
      type: "jsx_container",
      name: "Panel",
      propNames: ["meta", "title"],
    });
    expect(propsOf(reparsedPanel)).toMatchObject({ meta: { nested: { hp: 10 } }, title: "Stats" });
  });
});

function docFrom(blocks: readonly PMNode[]): PMNode {
  return schema.node("doc", null, blocks);
}

function blocksOf(doc: PMNode): PMNode[] {
  return [...doc.content.content];
}

function renderedComponent(html: string, name: string): Element {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const element = [...parsed.querySelectorAll("[data-name]")].find(
    (candidate) => candidate.getAttribute("data-name") === name,
  );
  if (!element) throw new Error(`Missing rendered JSX component ${name}`);
  return element;
}

function propNamesFromElement(element: Element): string[] {
  const props = JSON.parse(element.getAttribute("data-props") ?? "{}") as unknown;
  return propNamesOf(props);
}

function expectJsxComponent(
  node: PMNode,
  expected: { type: "jsx_leaf" | "jsx_container"; name: string; propNames: string[] },
): void {
  expect(node.type.name).toBe(expected.type);
  expect(node.attrs.name).toBe(expected.name);
  expect(propNamesOf(node.attrs.props)).toEqual(expected.propNames);
}

function propsOf(node: PMNode): Record<string, unknown> {
  const props = node.attrs.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new Error(`Expected object props for ${node.type.name}`);
  }
  return props as Record<string, unknown>;
}

function propNamesOf(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
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
