/** Server status must survive wire/GC boundaries, precision exhaustion, Apply and Undo. */
import {
  type AttributionPart,
  appendApplyRecord,
  type ItemRange,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  recordRestorations,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { appliedRecord } from "./draft-apply.js";
import { partsInChanges } from "./draft-edit-status.js";

const schema = buildDocumentSchema();
const paragraph = (text: string) => schema.nodes.paragraph.create(null, schema.text(text));
const fragment = (doc: Y.Doc) => doc.getXmlFragment("prosemirror");
const text = (doc: Y.Doc, block = 0) =>
  (fragment(doc).get(block) as Y.XmlElement).get(0) as Y.XmlText;

it.each([
  "budget insert",
  "budget delete",
  "Apply",
  "restoration",
])("%s status uses encoded and reloaded room evidence", (scenario) => {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const budget = scenario.startsWith("budget");
  const blocks = (
    budget
      ? ["first tail words", "unchanged separator words here", `${"echo ".repeat(2000)}tail`]
      : ["The red gate opens beside the tower."]
  ).map(paragraph);
  writeBlocks(fragment(doc), schema, blocks);
  writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema, blocks);
  const parts: AttributionPart[] = [];
  const ai = (run: () => void) => {
    doc.clientID = 200000 + parts.length;
    const client = doc.clientID;
    const from = Y.getState(doc.store, client);
    const deleted: ItemRange[] = [];
    const capture = (tr: Y.Transaction) => {
      for (const [client, ranges] of tr.deleteSet.clients)
        for (const { clock, len } of ranges) deleted.push([client, clock, len]);
    };
    doc.on("afterTransaction", capture);
    run();
    doc.off("afterTransaction", capture);
    const length = Y.getState(doc.store, client) - from;
    parts.push({
      threadId: `chat${parts.length}`,
      turnId: "turn",
      inserted: length ? [[client, from, length]] : [],
      deleted,
    });
  };
  if (budget) {
    ai(() => text(doc).insert(0, `${"X".repeat(63999)} `));
    ai(() =>
      scenario === "budget insert"
        ? text(doc, 2).insert(5000, "echo ")
        : text(doc, 2).delete(5000, 5),
    );
  } else {
    ai(() =>
      writeBlocks(fragment(doc), schema, [paragraph("The bed gate opens beside the tower.")]),
    );
    if (scenario === "Apply") {
      const entry = appliedRecord({
        input: {
          scope: "item",
          snapshot: Buffer.from(Y.encodeSnapshot(Y.snapshot(doc))).toString("base64"),
        },
        branchState: Y.encodeStateAsUpdate(doc),
        parts,
      });
      if (!entry) throw new Error("Apply did not produce a record");
      doc.clientID = 1;
      doc.transact(() => {
        appendApplyRecord(doc, entry);
        writeBlocks(
          doc.getXmlFragment(REVIEW_BASE_FRAGMENT),
          schema,
          readBlocks(fragment(doc), schema),
        );
      });
      doc.clientID = 300000;
      text(doc).delete(4, 3);
    } else {
      doc.clientID = 300000;
      const origin = Symbol("discard");
      const history = new Y.UndoManager(fragment(doc), { trackedOrigins: new Set([origin]) });
      recordRestorations(history);
      doc.transact(() => writeBlocks(fragment(doc), schema, blocks), origin);
      history.undo();
      history.destroy();
    }
  }
  const objectRange = ([client, clock, len]: ItemRange) => ({ client, clock, len });
  const effects = parts.map((part) => ({
    effect: { inserted: part.inserted.map(objectRange), deleted: part.deleted.map(objectRange) },
  }));
  for (const gc of [false, true]) {
    const reload = new Y.Doc({ gc });
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    expect(partsInChanges(reload, effects)).toEqual(parts.map(() => scenario !== "Apply"));
    reload.destroy();
  }
  doc.destroy();
});
