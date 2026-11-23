import { EditorState } from "prosemirror-state";
import { inText, RoomDocs, StructureView } from "@meridian/document-model";
import { movedText, readProseMirror, shapeSchemaOf, writeProseMirror } from "../../../src/index.js";
import { schema } from "../block-changes.gen.js";

const shape = shapeSchemaOf(schema);
const paragraph = (id: string, text: string) => schema.nodes.paragraph.create({ id }, schema.text(text));
const textOf = (docs: RoomDocs) => {
  const view = new StructureView(docs);
  return view.children(null).map((id) => inText(docs.textOf(id), (text) => text.toString())).join("");
};
const check = (name: string, got: string, want: string) => {
  if (got !== want) throw new Error(`${name}: ${JSON.stringify(got)}; wanted ${JSON.stringify(want)}`);
  console.log(`ok ${name}: ${JSON.stringify(got)}`);
};
const noDuplicateWords = (name: string, value: string) => {
  const words = value.match(/[A-Za-z]+/g) ?? [];
  if (new Set(words).size !== words.length) throw new Error(`${name}: duplicate words in ${JSON.stringify(value)}`);
  console.log(`ok ${name}: ${JSON.stringify(value)}`);
};

function split(docs: RoomDocs, at: number, id: string): void {
  const before = readProseMirror(docs, schema);
  const tr = EditorState.create({ schema, doc: before }).tr.split(at);
  const second = tr.doc.child(0).nodeSize;
  tr.setNodeAttribute(second, "id", id);
  writeProseMirror(docs, tr.doc, { previous: before, moved: movedText(tr) });
}

function deleteTail(docs: RoomDocs): void {
  const before = readProseMirror(docs, schema);
  const tr = EditorState.create({ schema, doc: before }).tr.delete(5, before.content.size - 1);
  writeProseMirror(docs, tr.doc, { previous: before });
}

function base(): RoomDocs {
  const docs = RoomDocs.create(shape, "1");
  writeProseMirror(docs, schema.topNodeType.create(null, [paragraph("a", "one two three")]));
  return docs;
}

{
  const live = base();
  const left = live.fork("2");
  const right = live.fork("3");
  split(left, 5, "b");
  split(right, 8, "c");
  const since = live.version();
  live.importBatch(left.exportSince(since));
  live.importBatch(right.exportSince(since));
  noDuplicateWords("two concurrent splits", textOf(live));
  check("two concurrent splits text", textOf(live), "one two three");
  left.free();
  right.free();
  live.free();
}

{
  const live = base();
  const mover = live.fork("2");
  const deleter = live.fork("3");
  split(mover, 5, "b");
  deleteTail(deleter);
  const since = live.version();
  live.importBatch(mover.exportSince(since));
  live.importBatch(deleter.exportSince(since));
  check("delete follows moved text", textOf(live), "one ");
  mover.free();
  deleter.free();
  live.free();
}

console.log("all room move cases pass");
