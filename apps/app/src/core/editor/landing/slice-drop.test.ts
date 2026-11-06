/** Multi-line slice drops preserve valid container structure and source order. */
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "@tiptap/pm/model";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import { expect, it } from "vitest";
import { droppedSlicePlan } from "./slice-drop";

const schema = buildDocumentSchema();
const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));
const item = (text: string, blocks: PMNode[] = []) =>
  schema.node("list_item", null, [paragraph(text), ...blocks]);
const textblockPositions = (doc: PMNode) => {
  const positions = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.isTextblock) positions.set(node.textContent, pos);
  });
  return positions;
};

function dropRange(
  doc: PMNode,
  source: { from: [string, number]; to: [string, number] },
  landing: [string, number],
  copy = false,
): EditorState {
  const positions = textblockPositions(doc);
  const position = ([text, offset]: [string, number]) =>
    (positions.get(text) as number) + 1 + offset;
  const from = position(source.from);
  const to = position(source.to);
  const pos = position(landing);
  let editorState = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, from, to),
  });
  const slice = editorState.selection.content();
  const view = {
    get state() {
      return editorState;
    },
    dragging: { slice },
    focus() {},
    dispatch(transaction: Transaction) {
      editorState = editorState.apply(transaction);
    },
  };
  const plan = droppedSlicePlan(
    view as never,
    { ctrlKey: copy, altKey: false } as DragEvent,
    slice,
    { kind: "inline", pos },
  );
  expect(plan.kind).toBe("accept");
  if (plan.kind === "accept") plan.commit?.(view as never);
  editorState.doc.check();
  return editorState;
}

it("keeps copied list items and their nested list in order", () => {
  const nested = schema.node("bullet_list", null, [item("nested kid text")]);
  const list = schema.node("bullet_list", null, [
    item("first bullet text"),
    item("second bullet text", [nested]),
    item("third bullet text"),
    item("fourth bullet text"),
  ]);
  const state = dropRange(
    schema.node("doc", null, [list, paragraph("landing words")]),
    { from: ["first bullet text", 2], to: ["fourth bullet text", 8] },
    ["landing words", 4],
    true,
  );

  expect(state.doc.textBetween(state.selection.from, state.selection.to, "\n")).toBe(
    "rst bullet text\nsecond bullet text\nnested kid text\nthird bullet text\nfourth b",
  );
});

it("empties a swept table cell without moving or scrambling the other cells", () => {
  const cell = (blocks: PMNode[]) => schema.node("table_cell", null, blocks);
  const row = (cells: PMNode[]) => schema.node("table_row", null, cells);
  const table = schema.node("table", null, [
    row([cell([paragraph("one")]), cell([paragraph("two")])]),
    row([
      cell([paragraph("cell first"), paragraph("cell second")]),
      cell([paragraph("cell four")]),
    ]),
  ]);
  const state = dropRange(
    schema.node("doc", null, [table, paragraph("landing words")]),
    { from: ["cell first", 0], to: ["cell second", "cell second".length] },
    ["landing words", 4],
  );

  const lines: string[] = [];
  state.doc.descendants((node) => {
    if (node.isTextblock) lines.push(node.textContent);
  });
  expect(lines).toEqual([
    "one",
    "two",
    "",
    "cell four",
    "land",
    "cell first",
    "cell second",
    "ing words",
  ]);
});
