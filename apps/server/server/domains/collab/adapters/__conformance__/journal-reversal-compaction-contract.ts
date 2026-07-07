import type { ReversalRecord, ReversalStore, UpdateJournal } from "@meridian/agent-edit";
import { expect } from "vitest";
import * as Y from "yjs";

export type ReversalCompactionContractInput = {
  journal: UpdateJournal & ReversalStore;
  docId: string;
  threadId: string;
  turnIds: readonly [string, string];
  userId: string;
};

export async function expectReversalCompactionContract({
  journal,
  docId,
  threadId,
  turnIds,
  userId,
}: ReversalCompactionContractInput): Promise<void> {
  const doc = new Y.Doc({ gc: false });
  const [first, second] = await journal.appendBatch([
    {
      docId,
      update: insertText(doc, "Alpha"),
      meta: { origin: `agent:${turnIds[0]}`, actorTurnId: turnIds[0], seq: 0 },
      mutation: { mode: "threadPeer", threadId, turnId: turnIds[0], branchGeneration: 1 },
    },
    {
      docId,
      update: insertText(doc, " Beta"),
      meta: { origin: `agent:${turnIds[1]}`, actorTurnId: turnIds[1], seq: 0 },
      mutation: { mode: "threadPeer", threadId, turnId: turnIds[1], branchGeneration: 1 },
    },
  ]);
  expect([first?.wId, second?.wId]).toEqual([1, 2]);
  expect(doc.getText("body").toString()).toBe("Alpha Beta");

  const undoUpdate = deleteAllText(doc);
  const undoRecord: ReversalRecord = {
    documentId: docId,
    threadId,
    turnId: turnIds[1],
    writeIds: ["w1", "w2"],
    status: "reversed",
    undoUpdateSeq: 0,
    reversedAt: new Date("2026-06-21T00:00:00.000Z"),
    reversedByUserId: userId,
  };
  await journal.persistUndo(docId, undoUpdate, [undoRecord], { type: "user", userId });
  expect(doc.getText("body").toString()).toBe("");
  const undoSeq = (await journal.mutationsForWrite(docId, threadId, "w1"))[0]?.undoUpdateSeq;
  expect(undoSeq).toBeGreaterThan(second?.seq ?? 0);

  const redoUpdate = insertText(doc, "Alpha Beta");
  const redo = await journal.persistRedo(
    docId,
    redoUpdate,
    { threadId, undoUpdateSeq: undoSeq ?? -1 },
    { origin: "system", seq: 0 },
  );
  expect(redo.consumed).toBe(true);
  expect(redo.seq).toBeGreaterThan(undoSeq ?? 0);
  expect(doc.getText("body").toString()).toBe("Alpha Beta");

  expect(
    [...(await journal.reversalOpSeqsForHandles(docId, threadId, ["w1", "w2"]))].sort(
      (left, right) => left - right,
    ),
  ).toEqual([undoSeq, redo.seq]);

  await journal.compact(docId, new Date("2100-01-01T00:00:00.000Z"));

  const reconstruction = await journal.readForReconstruction(docId);
  expect(reconstruction.checkpoint).toBeInstanceOf(Uint8Array);
  expect(reconstruction.updates).toEqual([]);
  expect(textFromSnapshot(reconstruction)).toBe("Alpha Beta");
  expect(await journal.reversalOpSeqsForHandles(docId, threadId, ["w1", "w2"])).toEqual(new Set());
  expect(await journal.readReversals(docId, { threadId })).toMatchObject([
    { writeIds: ["w1"], status: "expired", undoUpdateSeq: undoSeq, redoUpdateSeq: redo.seq },
    { writeIds: ["w2"], status: "expired", undoUpdateSeq: undoSeq, redoUpdateSeq: redo.seq },
  ]);
}

function insertText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(text.toString().length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

function deleteAllText(doc: Y.Doc): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.delete(0, text.length);
  return Y.encodeStateAsUpdate(doc, before);
}

function textFromSnapshot(snapshot: {
  checkpoint: Uint8Array | null;
  updates: { update: Uint8Array }[];
}) {
  const doc = new Y.Doc({ gc: false });
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
  for (const update of snapshot.updates) Y.applyUpdate(doc, update.update);
  return doc.getText("body").toString();
}
