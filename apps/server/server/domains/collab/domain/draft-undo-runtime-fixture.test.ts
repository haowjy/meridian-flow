/** Runtime-captured Yjs rows that guard browser undo attribution. */
import { readFileSync } from "node:fs";
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

type RuntimeFixture = {
  liveCheckpointB64: string;
  sequences: Record<"A" | "B", RuntimeFixtureUpdate[]>;
};

type RuntimeFixtureUpdate = {
  id: number;
  actorTurnId: string | null;
  actorUserId?: string | null;
  updateB64: string;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/draft-undo-runtime/phase2.fixture", import.meta.url),
    "utf8",
  ),
) as RuntimeFixture;

const SEQUENCE_A_UPDATES = fixture.sequences.A.map(indexedUpdateFromFixture);
const SEQUENCE_B_UPDATES = fixture.sequences.B.map(indexedUpdateFromFixture);

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

function indexedUpdateFromFixture(update: RuntimeFixtureUpdate): IndexedDraftUpdate {
  return {
    id: update.id,
    actorTurnId: update.actorTurnId,
    ...(update.actorUserId ? { actorUserId: update.actorUserId } : {}),
    updateData: fromB64(update.updateB64),
  };
}

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
  Y.applyUpdate(doc, fromB64(fixture.liveCheckpointB64));
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
