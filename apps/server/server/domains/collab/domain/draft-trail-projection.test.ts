/** Trail projection coverage for durable locations across split structural writes. */
import {
  createAgentEditCodecFactory,
  getBlockItemId,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { preparedTrailChanges } from "./draft-trail-projection.js";

it("traces multi-block identity shifts back to the displaced passage", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
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
        beforeBlockIdentity: getBlockItemId(alpha),
        afterBlockIdentity: getBlockItemId(alpha),
        beforeText: "Alpha.",
        afterText: "Bravo.",
      },
      {
        blockId: bravoId,
        beforeBlockIdentity: getBlockItemId(bravo),
        afterBlockIdentity: getBlockItemId(bravo),
        beforeText: "Bravo.",
        afterText: "Charlie.",
      },
      {
        blockId: charlieId,
        beforeBlockIdentity: getBlockItemId(charlie),
        afterBlockIdentity: null,
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
    before: [
      { hash: alphaId, serialized: "Alpha.", ...getBlockItemId(alpha) },
      { hash: bravoId, serialized: "Bravo.", ...getBlockItemId(bravo) },
      { hash: charlieId, serialized: "Charlie.", ...getBlockItemId(charlie) },
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
  const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
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
        beforeBlockIdentity: getBlockItemId(alpha),
        afterBlockIdentity: getBlockItemId(alpha),
        beforeText: "Alpha.",
        afterText: "Bravo.",
      },
      {
        blockId: bravoId,
        beforeBlockIdentity: getBlockItemId(bravo),
        afterBlockIdentity: null,
        beforeText: "Bravo.",
        afterText: null,
      },
      {
        blockId: charlieId,
        beforeBlockIdentity: getBlockItemId(charlie),
        afterBlockIdentity: getBlockItemId(charlie),
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
    before: [
      { hash: alphaId, serialized: "Alpha.", ...getBlockItemId(alpha) },
      { hash: bravoId, serialized: "Bravo.", ...getBlockItemId(bravo) },
      { hash: charlieId, serialized: "Charlie.", ...getBlockItemId(charlie) },
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

it("keeps canonical identities distinct when snapshot block hashes collide", () => {
  const schema = buildDocumentSchema();
  const codec = createAgentEditCodecFactory(mdxCodec({ schema })).forScope(UNSCOPED_DOCUMENT_LINKS);
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
        beforeBlockIdentity: beforeIdentity,
        afterBlockIdentity: afterIdentity,
        beforeText: "Alpha.",
        afterText: "Xray.",
      },
    ],
    receiptId: "receipt-hash-collision",
    ownersByBlock: new Map([[collidingHash, [null]]]),
    before: [
      {
        hash: collidingHash,
        serialized: "Alpha.",
        ...beforeIdentity,
      },
    ],
    // Push preparation intentionally stores the after snapshot last when the
    // display hash collides, so both canonical identities must come from
    // the explicit Apply change rather than this combined lookup.
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
