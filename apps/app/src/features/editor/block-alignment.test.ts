import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import { currentAlignableBlock, setCurrentBlockAlignment } from "./block-alignment";

const schema = buildDocumentSchema();

describe("current block alignment", () => {
  it("updates only the block at the selection head", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("a")),
      schema.node("paragraph", null, schema.text("b")),
    ]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 4),
    });

    const transaction = setCurrentBlockAlignment(state, "right");
    if (!transaction) throw new Error("expected an alignment transaction");
    const changed = state.apply(transaction);
    expect(changed.doc.child(0).attrs.align).toBeNull();
    expect(changed.doc.child(1).attrs.align).toBe("right");
  });

  it("resolves the containing table rather than its cell paragraph", () => {
    const paragraph = schema.node("paragraph", null, schema.text("cell"));
    const table = schema.node("table", null, [
      schema.node("table_row", null, [schema.node("table_cell", null, [paragraph])]),
    ]);
    const doc = schema.node("doc", null, [table]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 4) });

    const target = currentAlignableBlock(state);
    expect(target?.node.type.name).toBe("table");
    expect(target?.pos).toBe(0);
  });

  it("clears alignment on the current block", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 2, align: "center" }, schema.text("heading")),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
    const transaction = setCurrentBlockAlignment(state, null);
    if (!transaction) throw new Error("expected an alignment transaction");

    expect(state.apply(transaction).doc.firstChild?.attrs.align).toBeNull();
  });
});
