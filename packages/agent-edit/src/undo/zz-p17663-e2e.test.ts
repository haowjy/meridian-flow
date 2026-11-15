import { writeFileSync } from "node:fs";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { it } from "vitest";
import * as Y from "yjs";
import { writeBlocks } from "../diff/writer.js";
import { pmNodeToYElement } from "../model/y-prosemirror.js";
import { textInRanges } from "../yjs-mutation.js";
import { captureEditFrontier, captureEditParts, computeInverse, type InversePart } from "./forward-inverse.js";
import { takeReplacements } from "./replacement-record.js";

const schema = buildDocumentSchema();
const FRAG = "prosemirror";
const para = (id: string, nodes: Parameters<typeof schema.nodes.paragraph.create>[1]) => schema.nodes.paragraph.create({ id }, nodes);
it("the real writer records each splice, and the inverse reads it", () => {
  const out: string[] = [];
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2000;
  doc.getXmlFragment(FRAG).insert(0, [pmNodeToYElement(para("p1", schema.text("One red dog small cat sat.")))]);
  const text = () => (doc.getXmlFragment(FRAG).get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const plain = () => (text().toDelta() as { insert: string }[]).map((d) => d.insert).join("");
  // The AI's write, through the Yjs writer (the lowering's word diff, then applyOps/applyTextOp).
  const frontier = captureEditFrontier(doc), updates: Uint8Array[] = [];
  let recorded: ReturnType<typeof takeReplacements> = [];
  const collect = (u: Uint8Array, _o: unknown, _d: Y.Doc, tr: Y.Transaction) => { updates.push(u); recorded = recorded.concat(takeReplacements(tr)); };
  doc.clientID = 10000;
  doc.on("update", collect);
  doc.transact(() => writeBlocks(doc.getXmlFragment(FRAG), schema, [para("p1", [schema.text("One blue dog "), schema.text("big", [schema.marks.strong.create()]), schema.text(" cat.")])]));
  doc.off("update", collect);
  out.push(`after write: ${plain()}`);
  out.push(`recorded: ${recorded.map((p) => `${JSON.stringify(textInRanges(doc, p.deleted))} -> ${JSON.stringify(textInRanges(doc, p.inserted))}`).join("; ")}`);
  const [part] = captureEditParts(doc, [{ frontier, update: Y.mergeUpdates(updates), replacements: recorded }]);
  out.push(`stored: ${JSON.stringify(part.effect.replacements)}`);
  const history: InversePart[] = [{ ...part, id: 1, editId: "e1", ordinal: 0, kind: "write", targets: [] }];
  doc.clientID = 2002;
  text().insert(plain().indexOf("big"), "very ", {});
  text().insert(plain().indexOf("blue"), "quite ", {});
  out.push(`writer typed: ${plain()}`);
  let next = 20000;
  for (const direction of ["invert", "reapply", "invert"] as const) {
    const result = computeInverse(doc, history, [{ part: history[0], direction }], { actionId: `a${next}`, allocateClient: () => next++ });
    for (const edit of result.edits) for (const [ordinal, p] of edit.parts.entries()) {
      Y.applyUpdate(doc, p.update);
      history.push({ ...p, id: history.length + 1, editId: `i${history.length}`, ordinal, kind: direction === "invert" ? "undo" : "redo", actionId: result.actionId });
    }
    out.push(`${direction}: ${plain()}`);
  }
  writeFileSync("/tmp/p17663/e2e.txt", out.join("\n"));
});
