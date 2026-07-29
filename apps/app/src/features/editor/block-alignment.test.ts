import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";

import {
  alignableBlocksInSelection,
  alignSelectedBlocks,
  currentAlignableBlock,
} from "./block-alignment";

const schema = buildDocumentSchema();

describe("current block alignment", () => {
  it("aligns every block the selection covers", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, schema.text("a")),
      schema.node("paragraph", null, schema.text("b")),
      schema.node("paragraph", null, schema.text("c")),
    ]);
    const state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 4),
    });

    const transaction = alignSelectedBlocks(state, "right");
    if (!transaction) throw new Error("expected an alignment transaction");
    const changed = state.apply(transaction);
    expect(changed.doc.child(0).attrs.align).toBe("right");
    expect(changed.doc.child(1).attrs.align).toBe("right");
    // Untouched blocks keep theirs: the selection is the scope.
    expect(changed.doc.child(2).attrs.align).toBeNull();
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
    // One table, one alignment target, however many cells the selection spans.
    expect(alignableBlocksInSelection(state)).toHaveLength(1);
  });

  it("refuses a block the schema gives no align attribute", () => {
    const doc = schema.node("doc", null, [
      schema.node("code_block", { language: "ts" }, schema.text("const gate = 3")),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });

    // A fence keeps its own layout, and a table CELL carries `alignment`
    // rather than `align` — near-misses a list of node names would invite.
    expect(alignableBlocksInSelection(state)).toHaveLength(0);
    expect(alignSelectedBlocks(state, "center")).toBeNull();
  });

  it("clears alignment on the current block", () => {
    const doc = schema.node("doc", null, [
      schema.node("heading", { level: 2, align: "center" }, schema.text("heading")),
    ]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1) });
    const transaction = alignSelectedBlocks(state, null);
    if (!transaction) throw new Error("expected an alignment transaction");

    expect(state.apply(transaction).doc.firstChild?.attrs.align).toBeNull();
  });
});
