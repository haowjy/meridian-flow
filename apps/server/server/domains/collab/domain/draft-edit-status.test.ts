/** Server status must survive wire/GC boundaries, precision exhaustion, Apply and Undo. */
import {
  type AttributionPart,
  appendApplyRecord,
  applySpanPatches,
  classifyChanges,
  composeGroups,
  diffBlocks,
  type ItemRange,
  projectReview,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  readRestorations,
  recordRestorations,
  writeBlocks,
  writeDiscardBlocks,
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

it.each([
  "inline atom",
  "low similarity",
  "block type",
])("partial Discard preserves the other chat's status and Apply evidence (%s)", (shape) => {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  const first =
    shape === "low similarity"
      ? Array.from({ length: 50 }, (_, i) => `base${i}`).join(" ")
      : "alpha";
  const middle = " beta gamma delta epsilon zeta eta theta iota ";
  const block = (start: string, end: string, heading = false) =>
    (heading ? schema.nodes.heading : schema.nodes.paragraph).create(
      heading ? { level: 1 } : null,
      [
        ...(shape === "inline atom" ? [schema.nodes.image.create({ src: "asset:test" })] : []),
        schema.text(start + middle + end),
      ],
    );
  const base = [block(first, "kappa")];
  writeBlocks(fragment(doc), schema, base);
  writeBlocks(doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema, base);
  const parts: AttributionPart[] = [];
  const ai = (blocks: ReturnType<typeof block>[]) => {
    doc.clientID = 200 + parts.length;
    const client = doc.clientID;
    const deleted: ItemRange[] = [];
    const capture = (tr: Y.Transaction) => {
      for (const [c, ranges] of tr.deleteSet.clients)
        for (const { clock, len } of ranges) deleted.push([c, clock, len]);
    };
    doc.on("afterTransaction", capture);
    if (shape === "block type") writeBlocks(fragment(doc), schema, blocks);
    else {
      const run = (fragment(doc).get(0) as Y.XmlElement)
        .toArray()
        .find((n) => n instanceof Y.XmlText) as Y.XmlText;
      doc.transact(() => {
        run.delete(0, first.length);
        run.insert(0, blocks[0].textContent.slice(0, -middle.length - 5));
      });
    }
    doc.off("afterTransaction", capture);
    parts.push({
      threadId: `chat${parts.length}`,
      turnId: "turn",
      inserted: [[client, 0, Y.getState(doc.store, client)]],
      deleted,
    });
  };
  const changed =
    shape === "low similarity"
      ? Array.from({ length: 50 }, (_, i) => `AI${i}`).join(" ")
      : shape === "block type"
        ? first
        : "ALPHA";
  ai([block(changed, "kappa", shape === "block type")]);
  // Use a direct text edit so the second chat owns only KAPPA, not the non-flat container.
  doc.clientID = 201;
  const run = (fragment(doc).get(0) as Y.XmlElement)
    .toArray()
    .find((n) => n instanceof Y.XmlText) as Y.XmlText;
  const at = run.length - 5;
  doc.transact(() => {
    run.delete(at, 5);
    run.insert(at, "KAPPA");
  });
  parts.push({ threadId: "chat1", turnId: "turn", inserted: [[201, 0, 5]], deleted: [] });
  const effects = parts.map((p) => ({
    effect: {
      inserted: p.inserted.map(([client, clock, len]) => ({ client, clock, len })),
      deleted: p.deleted.map(([client, clock, len]) => ({ client, clock, len })),
    },
  }));
  const projection = () => projectReview(diffBlocks(base, readBlocks(fragment(doc), schema)));
  const before = projection();
  expect(before.groups).toHaveLength(2);
  expect(partsInChanges(doc, effects)).toEqual([true, true]);
  const retained = [
    ...classifyChanges(doc, before, { userId: "u", parts }, { record: true }).values(),
  ][1];
  doc.clientID = 300;
  doc.transact(() =>
    writeDiscardBlocks(
      fragment(doc),
      schema,
      applySpanPatches(
        before.diff.draft.blocks,
        composeGroups(schema, before, [before.groups[0].id], "discard"),
        "draft",
      ),
    ),
  );
  for (const gc of [false, true]) {
    const reload = new Y.Doc({ gc });
    Y.applyUpdate(reload, Y.encodeStateAsUpdate(doc));
    const recorded = readRestorations(reload);
    for (const [client, clock, len] of recorded.links)
      expect(
        recorded.base.some(([c, k, n]) => c === client && k < clock + len && clock < k + n),
      ).toBe(false);
    expect(partsInChanges(reload, effects)[1]).toBe(true);
    if (shape !== "block type") expect(partsInChanges(reload, effects)[0]).toBe(false);
    const after = [
      ...classifyChanges(reload, projection(), { userId: "u", parts }, { record: true }).values(),
    ];
    expect(after).toHaveLength(1);
    expect(after[0].members).toContain(1);
    expect(after[0].byline).toEqual(retained.byline);
    if (shape !== "block type") expect(after[0].applied).toEqual(retained.applied);
    else expect(after[0].applied?.base.length).toBeGreaterThan(0);
    reload.destroy();
  }
  doc.destroy();
});
