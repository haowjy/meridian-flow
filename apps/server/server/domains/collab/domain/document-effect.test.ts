/** Draft effect and trail ownership: history alone is no effect, and a replacement names its author. */
import {
  createAgentEditCodecFactory,
  snapshotBlocks,
  toDocHandle,
  unwrapBlock,
  yProsemirrorModel,
} from "@meridian/agent-edit/integration";
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import { mdxCodec, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import { expect, it } from "vitest";
import { prosemirrorToYXmlFragment } from "y-prosemirror";
import * as Y from "yjs";
import { publicationBlockChanges } from "./branch-push-plan.js";
import {
  journalAttributionByChangedBlock,
  preparedTrailChanges,
} from "./branch-trail-projection.js";
import { documentEffectsEqual } from "./document-content.js";

const schema = buildDocumentSchema();
const codec = mdxCodec({ schema });
const model = yProsemirrorModel(schema);

function createDoc(markdown: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 1;
  prosemirrorToYXmlFragment(
    schema.node("doc", null, codec.parse(markdown).blocks),
    doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
  );
  return doc;
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2;
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(source));
  return doc;
}

it("treats a manifest-only difference as an effect but not a publication block change", () => {
  const live = createDoc("Alpha");
  const draft = cloneDoc(live);
  try {
    draft.getMap("documents").set("managed-document", true);
    expect(documentEffectsEqual(live, draft)).toBe(false);
    expect(publicationBlockChanges({ model, beforeDoc: live, afterDoc: draft })).toEqual([]);
  } finally {
    live.destroy();
    draft.destroy();
  }
});

it("names the author of a block replacement in the trail and counts retyping as no effect", () => {
  const live = createDoc("red\n\nControl");
  const draft = cloneDoc(live);
  try {
    const first = model.getBlocks(toDocHandle(draft))[0];
    draft.clientID = 201;
    const deltas: Uint8Array[] = [];
    draft.on("update", (update: Uint8Array) => deltas.push(update));
    draft.transact(() => {
      model.applyBlockReplacement(toDocHandle(draft), first, codec.parse("**red**").blocks[0]);
    });
    verifyReplacementTrail(live, draft, [
      { id: 1, actorTurnId: "turn-1", updateData: Y.mergeUpdates(deltas) },
    ]);
    // Rewriting a paragraph back to its own content is history, not an effect.
    const retyped = cloneDoc(live);
    const text = unwrapBlock(model.getBlocks(toDocHandle(retyped))[0]).get(0) as Y.XmlText;
    text.delete(0, text.length);
    text.insert(0, "red");
    expect(documentEffectsEqual(live, retyped)).toBe(true);
    retyped.destroy();
  } finally {
    live.destroy();
    draft.destroy();
  }
});

function verifyReplacementTrail(
  live: Y.Doc,
  draft: Y.Doc,
  rows: { id: number; actorTurnId: string | null; updateData: Uint8Array }[],
) {
  const scopedCodec = createAgentEditCodecFactory(codec).forScope(UNSCOPED_DOCUMENT_LINKS);
  const before = snapshotBlocks(toDocHandle(live), model, scopedCodec);
  const after = snapshotBlocks(toDocHandle(draft), model, scopedCodec);
  const bodies = (doc: Y.Doc) =>
    new Map(
      (doc === live ? before : after).map((block) => [
        `${block.clientID}:${block.clock}`,
        block.serialized,
      ]),
    );
  const changedBlocks = publicationBlockChanges({
    model,
    beforeDoc: live,
    afterDoc: draft,
    renderBlock(doc, block) {
      const identity = model.getCanonicalBlockIdentity(block);
      const body = bodies(doc).get(`${identity.clientID}:${identity.clock}`);
      if (body === undefined) throw new Error("Missing rich snapshot");
      return body;
    },
  });
  const attribution = journalAttributionByChangedBlock({
    priorDoc: live,
    model,
    rows: rows.map((row) => ({
      ...row,
      branchId: "draft",
      wId: row.id,
      source: "agent" as const,
      threadId: `thread-${row.id}` as ThreadId,
      turnId: row.actorTurnId as TurnId,
      actorUserId: null,
      draftBaseUpdateSeq: 1,
      status: "active" as const,
    })),
  });
  const afterById = new Map(
    model
      .getBlocks(toDocHandle(draft))
      .map((block) => [model.getBlockId(block), unwrapBlock(block)]),
  );
  const documentId = "document" as never;
  const trail = preparedTrailChanges({
    documentId,
    changedBlocks,
    receiptId: "receipt",
    ownersByBlock: attribution.ownersByBlock,
    operations: attribution.operations.map((operation) => ({
      ...operation,
      insertedBlocks: operation.insertedBlockIds.flatMap((blockId) => {
        const block = afterById.get(blockId);
        return block ? [{ blockId, block }] : [];
      }),
    })),
    before,
    blockIdentities: new Map(
      [...before, ...after].map((block) => [
        block.hash,
        { documentId, clientID: block.clientID, clock: block.clock },
      ]),
    ),
    afterIds: new Set(after.map((block) => block.hash)),
    afterById,
    afterDoc: draft,
  });
  expect(changedBlocks).toHaveLength(1);
  expect(changedBlocks[0].beforeBlockIdentity).toEqual({
    clientID: before[0].clientID,
    clock: before[0].clock,
  });
  expect(changedBlocks[0].afterBlockIdentity).toEqual({
    clientID: after[0].clientID,
    clock: after[0].clock,
  });
  expect(trail).toHaveLength(rows.length);
  for (const change of trail)
    expect(change).toMatchObject({
      kind: "modify",
      changeId: `receipt:document:${before[0].clientID}:${before[0].clock}`,
      beforeBlockIdentity: { documentId, clientID: before[0].clientID, clock: before[0].clock },
      afterBlockIdentity: { documentId, clientID: after[0].clientID, clock: after[0].clock },
      beforeText: before[0].serialized,
      afterTextAtReceipt: after[0].serialized,
    });
  expect(trail.map((change) => change.owner)).toEqual(
    rows.map((row) => ({ threadId: `thread-${row.id}`, turnId: row.actorTurnId })),
  );
}
