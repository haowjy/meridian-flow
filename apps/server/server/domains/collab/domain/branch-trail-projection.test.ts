/** Trail projection coverage for durable locations across split structural writes. */
import {
  createAgentEditCodec,
  getBlockItemId,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec, unresolvedAssetPathResolver } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import type { BranchJournalRow } from "./branch-push-contracts.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";

it("traces multi-block identity shifts back to the displaced passage", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
  );
  const model = yProsemirrorModel(schema);
  const beforeDoc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Alpha.\n\nBravo.\n\nCharlie."));
  const beforeBlocks = model.getBlocks(toDocHandle(beforeDoc));
  const alpha = beforeBlocks[0];
  const bravo = beforeBlocks[1];
  const charlie = beforeBlocks[2];
  if (!alpha || !bravo || !charlie) throw new Error("missing source blocks");
  const alphaId = model.getBlockId(alpha);
  const bravoId = model.getBlockId(bravo);
  const charlieId = model.getBlockId(charlie);

  const afterDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(beforeDoc));
  const afterBlocks = model.getBlocks(toDocHandle(afterDoc));
  const first = afterBlocks[0];
  const second = afterBlocks[1];
  const bravoReplacement = codec.parse("Bravo.").blocks[0];
  const charlieReplacement = codec.parse("Charlie.").blocks[0];
  if (!first || !second || !bravoReplacement || !charlieReplacement) {
    throw new Error("missing shifted blocks");
  }
  model.applyBlockReplacement(toDocHandle(afterDoc), first, bravoReplacement);
  model.applyBlockReplacement(toDocHandle(afterDoc), second, charlieReplacement);
  afterDoc.getXmlFragment("prosemirror").delete(2, 1);

  const survivingBlocks = model.getBlocks(toDocHandle(afterDoc));
  const firstSurvivor = survivingBlocks[0];
  const secondSurvivor = survivingBlocks[1];
  const firstElement = afterDoc.getXmlFragment("prosemirror").get(0);
  const secondElement = afterDoc.getXmlFragment("prosemirror").get(1);
  if (
    !firstSurvivor ||
    !secondSurvivor ||
    !(firstElement instanceof Y.XmlElement) ||
    !(secondElement instanceof Y.XmlElement)
  ) {
    throw new Error("missing shifted survivors");
  }
  const firstSurvivorId = model.getBlockId(firstSurvivor);
  const secondSurvivorId = model.getBlockId(secondSurvivor);

  const changes = preparedTrailChanges({
    documentId: "document-1" as never,
    changedBlocks: [
      {
        blockId: alphaId,
        beforeText: "Alpha.",
        afterText: "Bravo.",
      },
      {
        blockId: bravoId,
        beforeText: "Bravo.",
        afterText: "Charlie.",
      },
      {
        blockId: charlieId,
        beforeText: "Charlie.",
        afterText: null,
      },
    ],
    receiptId: "receipt-multi-shift",
    ownersByBlock: new Map([
      [alphaId, [null]],
      [bravoId, [null]],
      [charlieId, [null]],
    ]),
    operations: [],
    before: [
      { hash: alphaId, serialized: "Alpha." },
      { hash: bravoId, serialized: "Bravo." },
      { hash: charlieId, serialized: "Charlie." },
    ],
    blockIdentities: new Map([
      [alphaId, { documentId: "document-1", ...getBlockItemId(alpha) }],
      [bravoId, { documentId: "document-1", ...getBlockItemId(bravo) }],
      [charlieId, { documentId: "document-1", ...getBlockItemId(charlie) }],
      [firstSurvivorId, { documentId: "document-1", ...getBlockItemId(firstSurvivor) }],
      [secondSurvivorId, { documentId: "document-1", ...getBlockItemId(secondSurvivor) }],
    ]),
    afterIds: new Set([firstSurvivorId, secondSurvivorId]),
    afterById: new Map([
      [firstSurvivorId, firstElement],
      [secondSurvivorId, secondElement],
    ]),
    afterDoc,
  });

  expect(changes).toMatchObject([
    {
      kind: "delete",
      beforeText: "Alpha.",
      afterTextAtReceipt: null,
      navigation: { kind: "deletion_boundary" },
    },
  ]);
});

it("preserves ordinary changes when two blocks claim the same relocated passage", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
  );
  const model = yProsemirrorModel(schema);
  const beforeDoc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Alpha.\n\nBravo.\n\nCharlie."));
  const beforeBlocks = model.getBlocks(toDocHandle(beforeDoc));
  const alpha = beforeBlocks[0];
  const bravo = beforeBlocks[1];
  const charlie = beforeBlocks[2];
  if (!alpha || !bravo || !charlie) throw new Error("missing source blocks");
  const alphaId = model.getBlockId(alpha);
  const bravoId = model.getBlockId(bravo);
  const charlieId = model.getBlockId(charlie);

  const afterDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(beforeDoc));
  const afterBlocks = model.getBlocks(toDocHandle(afterDoc));
  const first = afterBlocks[0];
  const third = afterBlocks[2];
  const bravoReplacement = codec.parse("Bravo.").blocks[0];
  if (!first || !third || !bravoReplacement) throw new Error("missing replacement blocks");
  model.applyBlockReplacement(toDocHandle(afterDoc), first, bravoReplacement);
  model.applyBlockReplacement(toDocHandle(afterDoc), third, bravoReplacement);
  afterDoc.getXmlFragment("prosemirror").delete(1, 1);

  const survivingBlocks = model.getBlocks(toDocHandle(afterDoc));
  const firstSurvivor = survivingBlocks[0];
  const secondSurvivor = survivingBlocks[1];
  const firstElement = afterDoc.getXmlFragment("prosemirror").get(0);
  const secondElement = afterDoc.getXmlFragment("prosemirror").get(1);
  if (
    !firstSurvivor ||
    !secondSurvivor ||
    !(firstElement instanceof Y.XmlElement) ||
    !(secondElement instanceof Y.XmlElement)
  ) {
    throw new Error("missing surviving blocks");
  }
  const firstSurvivorId = model.getBlockId(firstSurvivor);
  const secondSurvivorId = model.getBlockId(secondSurvivor);

  const changes = preparedTrailChanges({
    documentId: "document-1" as never,
    changedBlocks: [
      {
        blockId: alphaId,
        beforeText: "Alpha.",
        afterText: "Bravo.",
      },
      {
        blockId: bravoId,
        beforeText: "Bravo.",
        afterText: null,
      },
      {
        blockId: charlieId,
        beforeText: "Charlie.",
        afterText: "Bravo.",
      },
    ],
    receiptId: "receipt-relocation-fan-in",
    ownersByBlock: new Map([
      [alphaId, [null]],
      [bravoId, [null]],
      [charlieId, [null]],
    ]),
    operations: [],
    before: [
      { hash: alphaId, serialized: "Alpha." },
      { hash: bravoId, serialized: "Bravo." },
      { hash: charlieId, serialized: "Charlie." },
    ],
    blockIdentities: new Map([
      [alphaId, { documentId: "document-1", ...getBlockItemId(alpha) }],
      [bravoId, { documentId: "document-1", ...getBlockItemId(bravo) }],
      [charlieId, { documentId: "document-1", ...getBlockItemId(charlie) }],
      [firstSurvivorId, { documentId: "document-1", ...getBlockItemId(firstSurvivor) }],
      [secondSurvivorId, { documentId: "document-1", ...getBlockItemId(secondSurvivor) }],
    ]),
    afterIds: new Set([firstSurvivorId, secondSurvivorId]),
    afterById: new Map([
      [firstSurvivorId, firstElement],
      [secondSurvivorId, secondElement],
    ]),
    afterDoc,
  });

  expect(changes).toMatchObject([
    {
      kind: "modify",
      beforeText: "Alpha.",
      afterTextAtReceipt: "Bravo.",
    },
    {
      kind: "delete",
      beforeText: "Bravo.",
      afterTextAtReceipt: null,
    },
    {
      kind: "modify",
      beforeText: "Charlie.",
      afterTextAtReceipt: "Bravo.",
    },
  ]);
});

it("does not relocate content from a structurally replaced source block", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
  );
  const model = yProsemirrorModel(schema);
  const beforeDoc = createCollabYDoc({ gc: false });
  model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Alpha.\n\nBravo."));
  const beforeBlocks = model.getBlocks(toDocHandle(beforeDoc));
  const alpha = beforeBlocks[0];
  const bravo = beforeBlocks[1];
  if (!alpha || !bravo) throw new Error("missing source blocks");
  const alphaId = model.getBlockId(alpha);
  const bravoId = model.getBlockId(bravo);

  const afterDoc = createCollabYDoc({ gc: false });
  Y.applyUpdate(afterDoc, Y.encodeStateAsUpdate(beforeDoc));
  const first = model.getBlocks(toDocHandle(afterDoc))[0];
  const bravoReplacement = codec.parse("Bravo.").blocks[0];
  if (!first || !bravoReplacement) throw new Error("missing shifted block");
  model.applyBlockReplacement(toDocHandle(afterDoc), first, bravoReplacement);
  afterDoc.getXmlFragment("prosemirror").delete(1, 1);
  afterDoc.clientID = 314_159_265;
  const shiftedBravo = model.getBlocks(toDocHandle(afterDoc))[0];
  if (!shiftedBravo) throw new Error("missing shifted survivor");
  model.insertBlocks(toDocHandle(afterDoc), shiftedBravo, codec.parse("Xray."));

  const afterBlocks = model.getBlocks(toDocHandle(afterDoc));
  const firstSurvivor = afterBlocks[0];
  const xray = afterBlocks[1];
  const firstElement = afterDoc.getXmlFragment("prosemirror").get(0);
  const xrayElement = afterDoc.getXmlFragment("prosemirror").get(1);
  if (
    !firstSurvivor ||
    !xray ||
    !(firstElement instanceof Y.XmlElement) ||
    !(xrayElement instanceof Y.XmlElement)
  ) {
    throw new Error("missing replacement blocks");
  }
  const firstSurvivorId = model.getBlockId(firstSurvivor);
  const xrayId = model.getBlockId(xray);

  const changes = preparedTrailChanges({
    documentId: "document-1" as never,
    changedBlocks: [
      {
        blockId: alphaId,
        beforeText: "Alpha.",
        afterText: "Bravo.",
      },
      {
        blockId: bravoId,
        beforeText: "Bravo.",
        afterText: null,
      },
      {
        blockId: xrayId,
        beforeText: null,
        afterText: "Xray.",
      },
    ],
    receiptId: "receipt-replacement-relocation",
    ownersByBlock: new Map([
      [alphaId, [null]],
      [bravoId, [null]],
    ]),
    operations: [
      {
        removedBlockHashes: [bravoId],
        insertedBlocks: [{ blockId: xrayId, block: xrayElement }],
        ambiguous: false,
      },
    ],
    before: [
      { hash: alphaId, serialized: "Alpha.", ...getBlockItemId(alpha) },
      { hash: bravoId, serialized: "Bravo.", ...getBlockItemId(bravo) },
    ],
    blockIdentities: new Map([
      [alphaId, { documentId: "document-1", ...getBlockItemId(alpha) }],
      [bravoId, { documentId: "document-1", ...getBlockItemId(bravo) }],
      [firstSurvivorId, { documentId: "document-1", ...getBlockItemId(firstSurvivor) }],
      [xrayId, { documentId: "document-1", ...getBlockItemId(xray) }],
    ]),
    afterIds: new Set([firstSurvivorId, xrayId]),
    afterById: new Map([
      [firstSurvivorId, firstElement],
      [xrayId, xrayElement],
    ]),
    afterDoc,
  });

  expect(changes).toMatchObject([
    {
      kind: "modify",
      beforeText: "Alpha.",
      afterTextAtReceipt: "Bravo.",
    },
    {
      kind: "modify",
      beforeText: "Bravo.",
      afterTextAtReceipt: "Xray.",
    },
  ]);
});

it("keeps canonical identities distinct when snapshot block hashes collide", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
  );
  const model = yProsemirrorModel(schema);
  const beforeDoc = createCollabYDoc({ gc: false });
  beforeDoc.clientID = 111_111_111;
  model.insertBlocks(toDocHandle(beforeDoc), null, codec.parse("Alpha."));
  const beforeBlock = model.getBlocks(toDocHandle(beforeDoc))[0];
  if (!beforeBlock) throw new Error("missing source block");
  const beforeIdentity = getBlockItemId(beforeBlock);

  const afterDoc = createCollabYDoc({ gc: false });
  afterDoc.clientID = 222_222_222;
  model.insertBlocks(toDocHandle(afterDoc), null, codec.parse("Xray."));
  const afterBlock = model.getBlocks(toDocHandle(afterDoc))[0];
  const afterElement = afterDoc.getXmlFragment("prosemirror").get(0);
  if (!afterBlock || !(afterElement instanceof Y.XmlElement)) {
    throw new Error("missing target block");
  }
  const afterIdentity = getBlockItemId(afterBlock);
  const collidingHash = "same-snapshot-hash";

  const changes = preparedTrailChanges({
    documentId: "document-1" as never,
    changedBlocks: [
      {
        blockId: collidingHash,
        beforeText: "Alpha.",
        afterText: "Xray.",
      },
    ],
    receiptId: "receipt-hash-collision",
    ownersByBlock: new Map([[collidingHash, [null]]]),
    operations: [],
    before: [
      {
        hash: collidingHash,
        serialized: "Alpha.",
        ...beforeIdentity,
      },
    ],
    // Push preparation intentionally stores the after snapshot last when the
    // display hash collides, so canonical before identity must come from
    // `before` rather than this combined lookup.
    blockIdentities: new Map([[collidingHash, { documentId: "document-1", ...afterIdentity }]]),
    afterIds: new Set([collidingHash]),
    afterById: new Map([[collidingHash, afterElement]]),
    afterDoc,
  });

  expect(changes).toMatchObject([
    {
      kind: "modify",
      beforeBlockIdentity: { documentId: "document-1", ...beforeIdentity },
      afterBlockIdentity: { documentId: "document-1", ...afterIdentity },
      beforeText: "Alpha.",
      afterTextAtReceipt: "Xray.",
      navigation: { kind: "live_block_range" },
    },
  ]);
});

it("keeps an unrelated deletion and insertion in one push as separate events", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodec(
    mdxCodec({ schema, assetPathResolver: unresolvedAssetPathResolver }),
  );
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
    documentId: "document-1" as never,
    changedBlocks: [
      {
        blockId: deletedId,
        beforeText: "Deleted.",
        afterText: null,
      },
      {
        blockId: insertedId,
        beforeText: null,
        afterText: "Unrelated.",
      },
    ],
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
    before: [
      { hash: deletedId, serialized: "Deleted." },
      { hash: survivorId, serialized: "Survivor." },
    ],
    blockIdentities: new Map([
      [deletedId, { documentId: "document-1", ...getBlockItemId(deleted) }],
      [insertedId, { documentId: "document-1", ...getBlockItemId(inserted) }],
    ]),
    afterIds: new Set([survivorAfterId, insertedId]),
    afterById: new Map([
      [survivorAfterId, survivorElement],
      [insertedId, insertedElement],
    ]),
    afterDoc,
  });

  expect(changes).toHaveLength(2);
  expect(changes.map((change) => change.kind)).toEqual(["delete", "insert"]);
  expect(changes[0]?.navigation.kind).toBe("deletion_boundary");
  expect(changes[1]?.navigation.kind).toBe("live_block_range");
});
