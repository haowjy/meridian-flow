/**
 * Guards the structural contract shared by the app's TipTap schema and the
 * server-side ProseMirror schema.
 */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { getSchema } from "@tiptap/core";
import type { AttributeSpec, MarkType, NodeType, Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";

import { createEditorExtensions } from "./config";

function projectAttrs(attrs: Record<string, AttributeSpec> | undefined) {
  return Object.fromEntries(
    Object.entries(attrs ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, attr]) => [
        name,
        Object.hasOwn(attr, "default") ? { default: attr.default } : {},
      ]),
  );
}

function projectNode(node: NodeType) {
  const { spec } = node;
  return {
    attrs: projectAttrs(spec.attrs),
    content: spec.content,
    group: spec.group,
    marks: spec.marks,
    inline: spec.inline,
    atom: spec.atom,
    code: spec.code,
    defining: spec.defining,
    isolating: spec.isolating,
    tableRole: spec.tableRole,
    draggable: spec.draggable,
    selectable: spec.selectable,
  };
}

function projectMark(mark: MarkType) {
  const { spec } = mark;
  return {
    attrs: projectAttrs(spec.attrs),
    inclusive: spec.inclusive,
    code: spec.code,
    excludes: spec.excludes,
  };
}

function projectSchema(schema: Schema) {
  return {
    nodes: Object.fromEntries(
      Object.entries(schema.nodes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, node]) => [name, projectNode(node)]),
    ),
    marks: Object.fromEntries(
      Object.entries(schema.marks)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, mark]) => [name, projectMark(mark)]),
    ),
  };
}

describe("TipTap editor schema parity", () => {
  it("matches the server document schema's structural contract", () => {
    const document = new Y.Doc();
    const awareness = new Awareness(document);

    try {
      const editorSchema = getSchema(
        createEditorExtensions({
          document,
          awareness,
          showCollaborationDecorations: false,
        }),
      );

      expect(projectSchema(editorSchema)).toEqual(projectSchema(buildDocumentSchema()));
    } finally {
      awareness.destroy();
      document.destroy();
    }
  });
});
