/** Runtime-captured Yjs rows that currently diverge from synthetic unit fixtures. */
import {
  type JournalSnapshot,
  reconstructUndoUpdateFromSnapshot,
  toDocHandle,
  yProsemirrorModel,
} from "@meridian/agent-edit";
import {
  buildDocumentSchema,
  createCollabYDoc,
  PROSEMIRROR_FRAGMENT_NAME,
} from "@meridian/prosemirror-schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { computeDraftReviewHunks } from "./draft-review-hunks.js";
import type { IndexedDraftUpdate } from "./draft-review-operations.js";

const schema = buildDocumentSchema();
const model = yProsemirrorModel(schema);

const PHASE2_LIVE_CHECKPOINT_B64 =
  "ARbpBwAHAQtwcm9zZW1pcnJvcgMHaGVhZGluZwcA6QcABgQA6QcBEVBoYXNlIFR3byBDaGFwdGVyKADpBwAFbGV2ZWwBfQGH6QcAAwlwYXJhZ3JhcGgHAOkHFAYEAOkHFSpUaGUgbGFudGVybiBidXJuZWQgYmx1ZSBiZXNpZGUgTWFyYSdzIG1hcC6H6QcUAwlwYXJhZ3JhcGgHAOkHQAYEAOkHQTJTaGUgY291bnRlZCB0aHJlZSBxdWlldCBmb290ZmFsbHMgYmV5b25kIHRoZSBnYXRlLofpB0ADCXBhcmFncmFwaAcA6Qd0BgQA6Qd1O1RoZSBvbGQgbWFzdGVyIHdhaXRlZCB1bmRlciB0aGUgY2VkYXIgYW5kIHdhdGNoZWQgdGhlIG1vb24uh+kHdAMJcGFyYWdyYXBoBwDpB7EBBgQA6QeyAVVBIGxpdmUgc2VudGVuY2UgbWFya2VkIGZvciBkZWxldGlvbi4gVGhlIHJlc3Qgb2YgdGhpcyBwYXJhZ3JhcGggc2hvdWxkIHJlbWFpbiBzdGVhZHkuh+kHsQEDCXBhcmFncmFwaAcA6QeIAgYEAOkHiQI5UGxhaW4gdW5jaGFuZ2VkIHBhcmFncmFwaCBmb3IgdHlwaW5nIGFmdGVyIHJldmlldyBzdGFydHMuh+kHiAIDCXBhcmFncmFwaAcA6QfDAgYEAOkHxAIuRmluYWwgYW5jaG9yIHBhcmFncmFwaCBrZWVwcyB0aGUgY2hhcHRlciBjYWxtLgA=";

const SEQUENCE_A_UPDATES: IndexedDraftUpdate[] = [
  {
    id: 124,
    actorTurnId: "6bc49782-b8eb-4827-bda1-50799d69f0e8",
    updateData: fromB64("AQHRDwDE6Qcs6QctB2VtZXJhbGQB6QcBKQQ="),
  },
  {
    id: 125,
    actorTurnId: "2a0a96eb-3134-471b-b67c-39574960b166",
    updateData: fromB64("AQHSDwDE6QdS6QdTD2ZvdXIgdGh1bmRlcm91cwHpBwIpBE4F"),
  },
  {
    id: 126,
    actorTurnId: "a1318211-6ca9-41a1-838e-4967b71f74c9",
    updateData: fromB64("AQLTDwDE6QeDAekHhAEHYW5jaWVudMTpB68B6QewAQVzdG9ybQHpBwQpBE4FegqsAQQ="),
  },
  {
    id: 127,
    actorTurnId: "a9797f9b-7cf9-4fb5-85a5-7976bd898894",
    updateData: fromB64("AAHpBwUpBE4FegqsAQSzASU="),
  },
  {
    id: 129,
    actorTurnId: null,
    actorUserId: "14c775c6-abe3-4140-8075-68b6cf378f6f",
    updateData: fromB64("AQGg7+vZCwDE6Qco6QcpBGJsdWUB0Q8BAAc="),
  },
  {
    id: 130,
    actorTurnId: null,
    actorUserId: "14c775c6-abe3-4140-8075-68b6cf378f6f",
    updateData: fromB64("AQH/6rb3CADE6Qcs0Q8AB2VtZXJhbGQBoO/r2QsBAAQ="),
  },
];

const SEQUENCE_B_UPDATES: IndexedDraftUpdate[] = [
  {
    id: 131,
    actorTurnId: "85471260-6d31-4c11-b2b4-1b18e687dd3a",
    updateData: fromB64("AQHRDwDE6Qcs6QctB2VtZXJhbGQB6QcBKQQ="),
  },
  {
    id: 132,
    actorTurnId: "88272319-6c43-4f7c-b91c-642244438ad1",
    updateData: fromB64("AQHSDwDE6QdS6QdTD2ZvdXIgdGh1bmRlcm91cwHpBwIpBE4F"),
  },
  {
    id: 133,
    actorTurnId: "1429fa4b-ee21-4f4c-85c2-7b1cb7fe2531",
    updateData: fromB64("AQLTDwDE6QeDAekHhAEHYW5jaWVudMTpB68B6QewAQVzdG9ybQHpBwQpBE4FegqsAQQ="),
  },
  {
    id: 134,
    actorTurnId: "89943b53-3e3a-45e9-a3ea-866fc4892ec4",
    updateData: fromB64("AAHpBwUpBE4FegqsAQSzASU="),
  },
  {
    id: 136,
    actorTurnId: null,
    actorUserId: "14c775c6-abe3-4140-8075-68b6cf378f6f",
    updateData: fromB64("AQGC/I7yDwDE0Q8C0Q8DAVgA"),
  },
  {
    id: 137,
    actorTurnId: null,
    actorUserId: "14c775c6-abe3-4140-8075-68b6cf378f6f",
    updateData: fromB64("AQHl1ozgDADE6Qco6QcpBGJsdWUCgvyO8g8BAAHRDwEABw=="),
  },
  {
    id: 138,
    actorTurnId: null,
    actorUserId: "14c775c6-abe3-4140-8075-68b6cf378f6f",
    updateData: fromB64(
      "AQOC/I7yDwHE0Q8CgvyO8g8AAVjE6Qcs0Q8AA2VtZcSC/I7yDwDRDwMEcmFsZAHl1ozgDAEABA==",
    ),
  },
  {
    id: 139,
    actorTurnId: null,
    actorUserId: "14c775c6-abe3-4140-8075-68b6cf378f6f",
    updateData: fromB64("AQGC/I7yDwnE6QeOAukHjwIBUQA="),
  },
  {
    id: 140,
    actorTurnId: null,
    actorUserId: "14c775c6-abe3-4140-8075-68b6cf378f6f",
    updateData: fromB64("AAGC/I7yDwEJAQ=="),
  },
];

describe("draft undo runtime fixtures", () => {
  it("Sequence A: real Ctrl+Z row should alias its recreated emerald bytes back to the original agent op", () => {
    const liveDoc = liveDocFromCheckpoint();
    const draftDoc = applyDraftUpdates(liveDoc, SEQUENCE_A_UPDATES);
    const result = computeDraftReviewHunks({
      liveDoc,
      draftDoc,
      model,
      draftUpdates: SEQUENCE_A_UPDATES,
    });

    expect(result.recommendedSurface).toBe("inline");
    if (result.recommendedSurface !== "inline") throw new Error("expected inline result");

    const agentOperation = result.operations.find((operation) => operation.operationId === "124");
    expect(agentOperation?.sourceUpdateIds).toEqual([124]);
    expect(agentOperation?.rejectSourceUpdateIds).toEqual([124, 129, 130]);
    expectRejectReturnsFirstParagraphToLive(liveDoc, SEQUENCE_A_UPDATES, agentOperation);
  });

  it("Sequence B: mixed discard undo should keep reject lineage on the original AI+writer rows, not the undo row", () => {
    const liveDoc = liveDocFromCheckpoint();
    const draftDoc = applyDraftUpdates(liveDoc, SEQUENCE_B_UPDATES);
    const result = computeDraftReviewHunks({
      liveDoc,
      draftDoc,
      model,
      draftUpdates: SEQUENCE_B_UPDATES,
    });

    expect(result.recommendedSurface).toBe("inline");
    if (result.recommendedSurface !== "inline") throw new Error("expected inline result");

    expect(
      result.hunks.some(
        (hunk) =>
          hunk.operationIds.includes("131") &&
          hunk.operationIds.some((operationId) => operationId.startsWith("writer:")),
      ),
    ).toBe(true);
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: "131",
          sourceUpdateIds: [131],
          rejectSourceUpdateIds: [131, 136, 137, 138],
        }),
        expect.objectContaining({
          operationId: expect.stringMatching(/^writer:136-/),
          sourceUpdateIds: [136],
          rejectSourceUpdateIds: [131, 136, 137, 138],
        }),
      ]),
    );
    expect(result.operations.map((operation) => operation.sourceUpdateIds)).not.toContainEqual([
      138,
    ]);

    const agentOperation = result.operations.find((operation) => operation.operationId === "131");
    expectRejectReturnsFirstParagraphToLive(liveDoc, SEQUENCE_B_UPDATES, agentOperation);
  });
});

function expectRejectReturnsFirstParagraphToLive(
  liveDoc: Y.Doc,
  updates: readonly IndexedDraftUpdate[],
  operation: { operationId: string; rejectSourceUpdateIds: number[] } | undefined,
): void {
  if (!operation) throw new Error("expected review operation");
  const draftDoc = applyDraftUpdates(liveDoc, updates);
  const undo = reconstructUndoUpdateFromSnapshot(snapshotFromFixture(liveDoc, updates), {
    docId: "fixture-doc",
    targetId: operation.operationId,
    targetSeqs: new Set(operation.rejectSourceUpdateIds),
    fragmentName: PROSEMIRROR_FRAGMENT_NAME,
  });

  Y.applyUpdate(draftDoc, undo.undoUpdate);

  expect(blockTexts(draftDoc)[0]).toBe(blockTexts(liveDoc)[0]);
}

function snapshotFromFixture(
  liveDoc: Y.Doc,
  updates: readonly IndexedDraftUpdate[],
): JournalSnapshot {
  return {
    checkpoint: Y.encodeStateAsUpdate(liveDoc),
    updates: updates.map((update) => ({
      seq: update.id,
      update: update.updateData,
      meta: { origin: "system", seq: update.id },
    })),
  };
}

function blockTexts(doc: Y.Doc): string[] {
  return model.getBlocks(toDocHandle(doc)).map((block) => model.getText(block));
}

function liveDocFromCheckpoint(): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, fromB64(PHASE2_LIVE_CHECKPOINT_B64));
  return doc;
}

function applyDraftUpdates(liveDoc: Y.Doc, updates: readonly IndexedDraftUpdate[]): Y.Doc {
  const doc = createCollabYDoc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(liveDoc));
  for (const update of updates) Y.applyUpdate(doc, update.updateData);
  return doc;
}

function fromB64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"));
}
