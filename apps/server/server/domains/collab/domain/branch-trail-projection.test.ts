/** Trail projection coverage for durable locations across split structural writes. */
import {
  createAgentEditCodec,
  getBlockItemId,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { planTrailForwardAction } from "../adapters/drizzle-trail-forward-actions.js";
import type { BranchJournalRow } from "./branch-push.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";

it("projects a same-identity whole-block rewrite as a live modification", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const model = yProsemirrorModel(schema);
  const liveDoc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(liveDoc), null, codec.parse("Writer text."));
  const branchDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(branchDoc, Y.encodeStateAsUpdate(liveDoc));
  const beforeVector = Y.encodeStateVector(branchDoc);
  const branchBlock = model.getBlocks(toDocHandle(branchDoc))[0];
  const replacement = codec.parse("Agent replacement.").blocks[0];
  if (!branchBlock || !replacement) throw new Error("missing rewrite fixture");
  model.applyBlockReplacement(toDocHandle(branchDoc), branchBlock, replacement);
  const updateData = Y.encodeStateAsUpdate(branchDoc, beforeVector);
  const beforeBlock = model.getBlocks(toDocHandle(liveDoc))[0];
  const afterBlock = model.getBlocks(toDocHandle(branchDoc))[0];
  const afterElement = branchDoc.getXmlFragment("prosemirror").get(0);
  if (!beforeBlock || !afterBlock || !(afterElement instanceof Y.XmlElement)) {
    throw new Error("missing rewritten block");
  }
  const beforeId = model.getBlockId(beforeBlock);
  const afterId = model.getBlockId(afterBlock);
  expect(getBlockItemId(afterBlock)).toEqual(getBlockItemId(beforeBlock));

  const attribution = journalAttributionByChangedBlock({
    liveDoc,
    rows: [
      {
        id: 1,
        branchId: "branch-1",
        generation: 1,
        wId: null,
        source: "agent",
        threadId: null,
        turnId: null,
        actorUserId: null,
        updateData,
        draftBaseUpdateSeq: 0,
        status: "active",
      },
    ],
    model,
  });
  expect(attribution.operations).toEqual([]);

  const changes = preparedTrailChanges({
    receipt: {
      version: 1,
      documentId: "document-1" as never,
      branchId: "branch-1",
      branchGeneration: 1,
      pushKind: "whole",
      changedBlocks: [
        {
          blockId: beforeId,
          beforeText: "Writer text.",
          afterText: "Agent replacement.",
          beforeWordCount: 2,
          afterWordCount: 2,
          wordDelta: 0,
        },
      ],
      totalWordDelta: 0,
    },
    receiptId: "receipt-same-identity",
    ownersByBlock: attribution.ownersByBlock,
    operations: [],
    conflictedBlocks: [beforeId],
    before: [{ hash: beforeId, serialized: "Writer text." }],
    blockIdentities: new Map([
      [beforeId, { documentId: "document-1", ...getBlockItemId(beforeBlock) }],
      [afterId, { documentId: "document-1", ...getBlockItemId(afterBlock) }],
    ]),
    beforeBodies: new Map([[beforeId, "Writer text."]]),
    afterIds: new Set([afterId]),
    afterById: new Map([[afterId, afterElement]]),
    afterDoc: branchDoc,
    beforeContentRef: 1,
  });

  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    kind: "modify",
    beforeBlockId: beforeId,
    afterBlockId: afterId,
    beforeText: "Writer text.",
    afterTextAtReceipt: "Agent replacement.",
    navigation: { kind: "live_block_range" },
  });

  model.applyTextEdit(
    toDocHandle(branchDoc),
    afterBlock,
    { from: 0, to: "Agent replacement.".length },
    "",
  );
  const emptiedBlock = model.getBlocks(toDocHandle(branchDoc))[0];
  const emptiedElement = branchDoc.getXmlFragment("prosemirror").get(0);
  if (!emptiedBlock || !(emptiedElement instanceof Y.XmlElement)) {
    throw new Error("missing emptied block");
  }
  const emptiedId = model.getBlockId(emptiedBlock);
  expect(getBlockItemId(emptiedBlock)).toEqual(getBlockItemId(afterBlock));

  const emptiedChanges = preparedTrailChanges({
    receipt: {
      version: 1,
      documentId: "document-1" as never,
      branchId: "branch-1",
      branchGeneration: 1,
      pushKind: "whole",
      changedBlocks: [
        {
          blockId: afterId,
          beforeText: "Agent replacement.",
          afterText: "",
          beforeWordCount: 2,
          afterWordCount: 0,
          wordDelta: -2,
        },
      ],
      totalWordDelta: -2,
    },
    receiptId: "receipt-emptied-identity",
    ownersByBlock: new Map([[afterId, [null]]]),
    operations: [],
    conflictedBlocks: [],
    before: [{ hash: afterId, serialized: "Agent replacement." }],
    blockIdentities: new Map([
      [afterId, { documentId: "document-1", ...getBlockItemId(afterBlock) }],
      [emptiedId, { documentId: "document-1", ...getBlockItemId(emptiedBlock) }],
    ]),
    beforeBodies: new Map([[afterId, "Agent replacement."]]),
    afterIds: new Set([emptiedId]),
    afterById: new Map([[emptiedId, emptiedElement]]),
    afterDoc: branchDoc,
    beforeContentRef: 1,
  });

  expect(emptiedChanges).toMatchObject([
    {
      kind: "delete",
      beforeBlockId: afterId,
      afterBlockId: null,
      afterBlockIdentity: null,
      navigation: { kind: "deletion_boundary" },
    },
  ]);
});

it("projects a structurally adjacent whole-block replacement as one modification", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const model = yProsemirrorModel(schema);
  const beforeDoc = createCollabYDoc({ gc: false });
  const afterDoc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Writer text."));
  model.insertBlocks(toDocHandle(afterDoc), null, codec.parse("Agent replacement."));
  const beforeBlock = model.getBlocks(toDocHandle(beforeDoc))[0];
  const afterBlock = model.getBlocks(toDocHandle(afterDoc))[0];
  if (!beforeBlock || !afterBlock) throw new Error("missing fixture blocks");
  const beforeId = model.getBlockId(beforeBlock);
  const afterId = model.getBlockId(afterBlock);
  const beforeIdentity = getBlockItemId(beforeBlock);
  const afterElement = afterDoc.getXmlFragment("prosemirror").get(0);
  if (!(afterElement instanceof Y.XmlElement)) throw new Error("missing replacement element");

  const branchDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(branchDoc, Y.encodeStateAsUpdate(beforeDoc));
  const beforeDelete = Y.encodeStateVector(branchDoc);
  branchDoc.getXmlFragment("prosemirror").delete(0, 1);
  const deleteUpdate = Y.encodeStateAsUpdate(branchDoc, beforeDelete);
  const beforeInsert = Y.encodeStateVector(branchDoc);
  model.insertBlocks(toDocHandle(branchDoc), null, codec.parse("Agent replacement."));
  const insertUpdate = Y.encodeStateAsUpdate(branchDoc, beforeInsert);
  const row = (id: number, updateData: Uint8Array): BranchJournalRow => ({
    id,
    branchId: "branch-1",
    generation: 1,
    wId: null,
    source: "agent",
    threadId: null,
    turnId: null,
    actorUserId: null,
    updateData,
    draftBaseUpdateSeq: 0,
    status: "active",
  });
  const attribution = journalAttributionByChangedBlock({
    liveDoc: beforeDoc,
    rows: [row(1, deleteUpdate), row(2, insertUpdate)],
    model,
  });
  expect(attribution.operations).toMatchObject([
    { removedBlockHashes: [beforeId], ambiguous: false },
  ]);

  const [change] = preparedTrailChanges({
    receipt: {
      version: 1,
      documentId: "document-1" as never,
      branchId: "branch-1",
      branchGeneration: 1,
      pushKind: "whole",
      changedBlocks: [
        {
          blockId: beforeId,
          beforeText: "Writer text.",
          afterText: null,
          beforeWordCount: 2,
          afterWordCount: 0,
          wordDelta: -2,
        },
        {
          blockId: afterId,
          beforeText: null,
          afterText: "Agent replacement.",
          beforeWordCount: 0,
          afterWordCount: 2,
          wordDelta: 2,
        },
      ],
      totalWordDelta: 0,
    },
    receiptId: "receipt-1",
    ownersByBlock: new Map([[beforeId, [null]]]),
    operations: attribution.operations.map((operation) => ({
      ...operation,
      insertedBlocks: operation.insertedBlockIds.map(() => ({
        blockId: afterId,
        block: afterElement,
      })),
    })),
    conflictedBlocks: [beforeId],
    before: [{ hash: beforeId, serialized: "Writer text." }],
    blockIdentities: new Map([
      [beforeId, { documentId: "document-1", ...beforeIdentity }],
      [afterId, { documentId: "document-1", ...getBlockItemId(afterBlock) }],
    ]),
    beforeBodies: new Map([[beforeId, "Writer text."]]),
    afterIds: new Set([afterId]),
    afterById: new Map([[afterId, afterElement]]),
    afterDoc,
    beforeContentRef: 1,
  });

  expect(change).toMatchObject({
    kind: "modify",
    beforeText: "Writer text.",
    afterTextAtReceipt: "Agent replacement.",
    afterBlockIdentity: { documentId: "document-1" },
    navigation: { kind: "live_block_range" },
    writerProtection: {
      kind: "sweep",
      body: { status: "available", markdown: "Writer text." },
    },
  });
  if (!change) throw new Error("missing projected change");
  const planned = planTrailForwardAction({
    liveDoc: afterDoc,
    change: { ...change, ordinal: 0, reversible: false },
    action: "restore",
    model,
    codec,
  });
  expect(planned).not.toBeNull();
  if (planned) Y.applyUpdate(afterDoc, planned.update);
  expect(codec.serialize(model.projectBlocks(toDocHandle(afterDoc))).trim()).toBe(
    "Writer text.\n\nAgent replacement.",
  );
});

it("keeps an unrelated deletion and insertion in one push as separate events", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const model = yProsemirrorModel(schema);
  const beforeDoc = createCollabYDoc({ gc: false });
  const afterDoc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Deleted.\n\nSurvivor."));
  Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(beforeDoc));
  const beforeDelete = Y.encodeStateVector(afterDoc);
  afterDoc.getXmlFragment("prosemirror").delete(0, 1);
  const deleteUpdate = Y.encodeStateAsUpdate(afterDoc, beforeDelete);
  const survivorAfter = model.getBlocks(toDocHandle(afterDoc))[0];
  if (!survivorAfter) throw new Error("missing survivor");
  const beforeInsert = Y.encodeStateVector(afterDoc);
  model.insertBlocks(toDocHandle(afterDoc), survivorAfter, codec.parse("Unrelated."));
  const insertUpdate = Y.encodeStateAsUpdate(afterDoc, beforeInsert);
  const [deleted, survivorBefore] = model.getBlocks(toDocHandle(beforeDoc));
  const [, inserted] = model.getBlocks(toDocHandle(afterDoc));
  if (!deleted || !survivorBefore || !inserted) {
    throw new Error("missing fixture blocks");
  }
  const deletedId = model.getBlockId(deleted);
  const insertedId = model.getBlockId(inserted);
  const survivorId = model.getBlockId(survivorBefore);
  const survivorAfterId = model.getBlockId(survivorAfter);
  const insertedElement = afterDoc.getXmlFragment("prosemirror").get(1);
  const survivorElement = afterDoc.getXmlFragment("prosemirror").get(0);
  if (!(insertedElement instanceof Y.XmlElement) || !(survivorElement instanceof Y.XmlElement)) {
    throw new Error("missing after elements");
  }
  const row = (id: number, updateData: Uint8Array): BranchJournalRow => ({
    id,
    branchId: "branch-1",
    generation: 1,
    wId: null,
    source: "agent",
    threadId: null,
    turnId: null,
    actorUserId: null,
    updateData,
    draftBaseUpdateSeq: 0,
    status: "active",
  });
  const attribution = journalAttributionByChangedBlock({
    liveDoc: beforeDoc,
    rows: [row(1, deleteUpdate), row(2, insertUpdate)],
    model,
  });

  const changes = preparedTrailChanges({
    receipt: {
      version: 1,
      documentId: "document-1" as never,
      branchId: "branch-1",
      branchGeneration: 1,
      pushKind: "whole",
      changedBlocks: [
        {
          blockId: deletedId,
          beforeText: "Deleted.",
          afterText: null,
          beforeWordCount: 1,
          afterWordCount: 0,
          wordDelta: -1,
        },
        {
          blockId: insertedId,
          beforeText: null,
          afterText: "Unrelated.",
          beforeWordCount: 0,
          afterWordCount: 1,
          wordDelta: 1,
        },
      ],
      totalWordDelta: 0,
    },
    receiptId: "receipt-unrelated",
    ownersByBlock: new Map([
      [deletedId, [null]],
      [insertedId, [null]],
    ]),
    operations: attribution.operations.map((operation) => ({
      ...operation,
      insertedBlocks: operation.insertedBlockIds.map((blockId) => ({
        blockId,
        block: insertedElement,
      })),
    })),
    conflictedBlocks: [deletedId],
    before: [
      { hash: deletedId, serialized: "Deleted." },
      { hash: survivorId, serialized: "Survivor." },
    ],
    blockIdentities: new Map([
      [deletedId, { documentId: "document-1", ...getBlockItemId(deleted) }],
      [insertedId, { documentId: "document-1", ...getBlockItemId(inserted) }],
    ]),
    beforeBodies: new Map([[deletedId, "Deleted."]]),
    afterIds: new Set([survivorAfterId, insertedId]),
    afterById: new Map([
      [survivorAfterId, survivorElement],
      [insertedId, insertedElement],
    ]),
    afterDoc,
    beforeContentRef: 1,
  });

  expect(changes).toHaveLength(2);
  expect(changes.map((change) => change.kind)).toEqual(["delete", "insert"]);
  expect(changes[0]?.navigation.kind).toBe("deletion_boundary");
  expect(changes[1]?.navigation.kind).toBe("live_block_range");
});

it("preserves proven-swept replacement promotion", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(mdxCodec({ schema }));
  const model = yProsemirrorModel(schema);
  const beforeDoc = createCollabYDoc({ gc: false });
  const afterDoc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Before."));
  model.insertBlocks(toDocHandle(afterDoc), null, codec.parse("After."));
  const beforeBlock = model.getBlocks(toDocHandle(beforeDoc))[0];
  const afterBlock = model.getBlocks(toDocHandle(afterDoc))[0];
  const afterElement = afterDoc.getXmlFragment("prosemirror").get(0);
  if (!beforeBlock || !afterBlock || !(afterElement instanceof Y.XmlElement)) {
    throw new Error("missing fixture blocks");
  }
  const beforeId = model.getBlockId(beforeBlock);
  const afterId = model.getBlockId(afterBlock);

  const changes = preparedTrailChanges({
    receipt: {
      version: 1,
      documentId: "document-1" as never,
      branchId: "branch-1",
      branchGeneration: 1,
      pushKind: "whole",
      changedBlocks: [
        {
          blockId: beforeId,
          beforeText: "Before.",
          afterText: null,
          beforeWordCount: 1,
          afterWordCount: 0,
          wordDelta: -1,
        },
        {
          blockId: afterId,
          beforeText: null,
          afterText: "After.",
          beforeWordCount: 0,
          afterWordCount: 1,
          wordDelta: 1,
        },
      ],
      totalWordDelta: 0,
    },
    receiptId: "receipt-proven",
    ownersByBlock: new Map([[beforeId, [null]]]),
    operations: [
      {
        removedBlockHashes: [beforeId],
        insertedBlocks: [{ blockId: afterId, block: afterElement }],
        ambiguous: false,
      },
    ],
    conflictedBlocks: [beforeId],
    before: [{ hash: beforeId, serialized: "Before." }],
    blockIdentities: new Map([
      [beforeId, { documentId: "document-1", ...getBlockItemId(beforeBlock) }],
      [afterId, { documentId: "document-1", ...getBlockItemId(afterBlock) }],
    ]),
    beforeBodies: new Map([[beforeId, "Before."]]),
    afterIds: new Set([afterId]),
    afterById: new Map([[afterId, afterElement]]),
    afterDoc,
    beforeContentRef: 1,
  });

  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    kind: "modify",
    beforeText: "Before.",
    afterTextAtReceipt: "After.",
    navigation: { kind: "live_block_range" },
    writerProtection: { kind: "sweep" },
  });
});
