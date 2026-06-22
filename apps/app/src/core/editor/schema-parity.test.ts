import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorExtensions } from "./config";

type AttrShape = Record<string, { default?: unknown }>;

type ComparableNodeSpec = {
  attrs?: unknown;
  content?: string;
  group?: string;
  marks?: string;
  inline?: boolean;
  atom?: boolean;
  code?: boolean;
  defining?: boolean;
  isolating?: boolean;
  draggable?: boolean;
  selectable?: boolean;
};

type ComparableMarkSpec = {
  attrs?: unknown;
  inclusive?: boolean;
  code?: boolean;
  excludes?: string;
};

type NodeShape = {
  attrs: AttrShape;
  content?: string;
  group?: string;
  marks?: string;
  inline?: boolean;
  atom?: boolean;
  code?: boolean;
  defining?: boolean;
  isolating?: boolean;
  draggable?: boolean;
  selectable?: boolean;
};

type MarkShape = {
  attrs: AttrShape;
  inclusive?: boolean;
  code?: boolean;
  excludes?: string;
};

function attrsShape(attrs: unknown): AttrShape {
  if (!attrs || typeof attrs !== "object") return {};

  return Object.fromEntries(
    Object.entries(attrs as Record<string, { default?: unknown }>).map(([name, attr]) => [
      name,
      Object.hasOwn(attr, "default") ? { default: attr.default } : {},
    ]),
  );
}

function nodeShape(node: { spec: unknown }): NodeShape {
  const spec = node.spec as ComparableNodeSpec;
  return {
    attrs: attrsShape(spec.attrs),
    content: spec.content,
    group: spec.group,
    marks: spec.marks,
    inline: spec.inline,
    atom: spec.atom,
    code: spec.code,
    defining: spec.defining,
    isolating: spec.isolating,
    draggable: spec.draggable,
    selectable: spec.selectable,
  };
}

function markShape(mark: { spec: unknown }): MarkShape {
  const spec = mark.spec as ComparableMarkSpec;
  return {
    attrs: attrsShape(spec.attrs),
    inclusive: spec.inclusive,
    code: spec.code,
    excludes: spec.excludes,
  };
}

describe("TipTap editor schema parity", () => {
  it("structurally matches the server document schema", () => {
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    const tiptapSchema = getSchema(createEditorExtensions({ document: ydoc, awareness }));
    const serverSchema = buildDocumentSchema();

    expect(Object.keys(tiptapSchema.nodes).sort()).toEqual(Object.keys(serverSchema.nodes).sort());
    expect(Object.keys(tiptapSchema.marks).sort()).toEqual(Object.keys(serverSchema.marks).sort());

    for (const nodeName of Object.keys(serverSchema.nodes)) {
      expect(nodeShape(tiptapSchema.nodes[nodeName]), nodeName).toEqual(
        nodeShape(serverSchema.nodes[nodeName]),
      );
    }

    for (const markName of Object.keys(serverSchema.marks)) {
      expect(markShape(tiptapSchema.marks[markName]), markName).toEqual(
        markShape(serverSchema.marks[markName]),
      );
    }

    expect(tiptapSchema.nodes.figure.spec.atom).toBe(true);
    expect(attrsShape(tiptapSchema.nodes.figure.spec.attrs)).toMatchObject({
      src: { default: "" },
      alt: { default: null },
      label: { default: null },
      caption: { default: "" },
    });
    expect(attrsShape(tiptapSchema.marks.link.spec.attrs)).toMatchObject({
      href: { default: "" },
      title: { default: null },
    });

    awareness.destroy();
    ydoc.destroy();
  });
});
