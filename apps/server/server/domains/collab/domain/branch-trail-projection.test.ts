/** Trail projection coverage for durable locations across split structural writes. */
import {
  createAgentEditCodec,
  getBlockItemId,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import { mdxCodec } from "@meridian/markup";
import { buildDocumentSchema, createCollabYDoc } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import * as Y from "yjs";
import { planTrailForwardAction } from "../adapters/drizzle-trail-forward-actions.js";
import { preparedTrailChanges } from "./branch-trail-projection.js";

it("restores a swept sole root before a replacement inserted by a separate operation", () => {
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
    operations: [
      { removedBlockHashes: [beforeId], insertedBlocks: [], ambiguous: true },
      {
        removedBlockHashes: [],
        insertedBlocks: [{ blockId: afterId, block: afterElement }],
        ambiguous: true,
      },
    ],
    conflictedBlocks: [beforeId],
    before: [{ hash: beforeId, serialized: "Writer text." }],
    blockIdentities: new Map([[beforeId, { documentId: "document-1", ...beforeIdentity }]]),
    beforeBodies: new Map([[beforeId, "Writer text."]]),
    afterIds: new Set([afterId]),
    afterById: new Map([[afterId, afterElement]]),
    afterDoc,
    beforeContentRef: 1,
  });

  expect(change).toMatchObject({
    kind: "delete",
    afterBlockIdentity: null,
    navigation: { kind: "deletion_boundary", affinity: "before_next" },
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
