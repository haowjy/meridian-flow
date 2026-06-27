import type { ReversalRecord, ReversalStore, UpdateJournal } from "@meridian/agent-edit";
import { expect } from "vitest";
import * as Y from "yjs";

export type ReversalMutationStatusContractInput = {
  journal: UpdateJournal & ReversalStore;
  docId: string;
  threadId: string;
  turnIds: readonly [string, string];
  userId: string;
};

export async function expectReversalMutationStatusContract({
  journal,
  docId,
  threadId,
  turnIds,
  userId,
}: ReversalMutationStatusContractInput): Promise<void> {
  const doc = new Y.Doc({ gc: false });
  const [first, second] = await journal.appendBatch([
    {
      docId,
      update: appendText(doc, "Alpha"),
      meta: { origin: `agent:${turnIds[0]}`, actorTurnId: turnIds[0], seq: 0 },
      mutation: { threadId, turnId: turnIds[0] },
    },
    {
      docId,
      update: appendText(doc, " Beta"),
      meta: { origin: `agent:${turnIds[1]}`, actorTurnId: turnIds[1], seq: 0 },
      mutation: { threadId, turnId: turnIds[1] },
    },
  ]);

  expect(first?.wId).toBe(1);
  expect(second?.wId).toBe(2);
  await expectMutation(journal, docId, threadId, "w1", {
    status: "active",
    createdSeq: first?.seq,
    undoUpdateSeq: undefined,
  });
  await expectMutation(journal, docId, threadId, "w2", {
    status: "active",
    createdSeq: second?.seq,
    undoUpdateSeq: undefined,
  });

  const firstUndoSeq = await persistUndoForHandles(journal, doc, {
    docId,
    threadId,
    turnId: turnIds[0],
    handles: ["w1"],
    userId,
    text: " Undo",
  });
  expect(firstUndoSeq).toBeGreaterThan(second?.seq ?? 0);
  await expectMutation(journal, docId, threadId, "w1", {
    status: "reversed",
    createdSeq: first?.seq,
    undoUpdateSeq: firstUndoSeq,
  });
  await expectMutation(journal, docId, threadId, "w2", {
    status: "active",
    createdSeq: second?.seq,
    undoUpdateSeq: undefined,
  });
  await expectReversal(journal, docId, threadId, "w1", {
    status: "reversed",
    undoUpdateSeq: firstUndoSeq,
    redoUpdateSeq: undefined,
  });

  const firstRedo = await persistRedoForUndo(journal, doc, docId, threadId, firstUndoSeq, " Redo");
  await expectMutation(journal, docId, threadId, "w1", {
    status: "active",
    createdSeq: first?.seq,
    undoUpdateSeq: undefined,
  });
  await expectMutation(journal, docId, threadId, "w2", {
    status: "active",
    createdSeq: second?.seq,
    undoUpdateSeq: undefined,
  });
  await expectReversal(journal, docId, threadId, "w1", {
    status: "redone",
    undoUpdateSeq: firstUndoSeq,
    redoUpdateSeq: firstRedo,
  });

  const secondUndoSeq = await persistUndoForHandles(journal, doc, {
    docId,
    threadId,
    turnId: turnIds[0],
    handles: ["w1"],
    userId,
    text: " Undo again",
  });
  await expectReversal(journal, docId, threadId, "w1", {
    status: "reversed",
    undoUpdateSeq: secondUndoSeq,
    redoUpdateSeq: undefined,
  });

  const secondRedo = await persistRedoForUndo(
    journal,
    doc,
    docId,
    threadId,
    secondUndoSeq,
    " Redo again",
  );
  expect(secondRedo).toBeGreaterThan(firstRedo);
  await expectReversal(journal, docId, threadId, "w1", {
    status: "redone",
    undoUpdateSeq: secondUndoSeq,
    redoUpdateSeq: secondRedo,
  });

  const groupedUndoSeq = await persistUndoForHandles(journal, doc, {
    docId,
    threadId,
    turnId: turnIds[0],
    handles: ["w1", "w2"],
    userId,
    text: " Group undo",
  });
  await expectReversal(journal, docId, threadId, "w1", {
    status: "reversed",
    undoUpdateSeq: groupedUndoSeq,
    redoUpdateSeq: undefined,
  });
  await expectReversal(journal, docId, threadId, "w2", {
    status: "reversed",
    undoUpdateSeq: groupedUndoSeq,
    redoUpdateSeq: undefined,
  });

  const groupedRedo = await persistRedoForUndo(
    journal,
    doc,
    docId,
    threadId,
    groupedUndoSeq,
    " Group redo",
  );
  for (const handle of ["w1", "w2"]) {
    await expectReversal(journal, docId, threadId, handle, {
      status: "redone",
      undoUpdateSeq: groupedUndoSeq,
      redoUpdateSeq: groupedRedo,
    });
  }
}

async function persistUndoForHandles(
  journal: ReversalStore,
  doc: Y.Doc,
  input: {
    docId: string;
    threadId: string;
    turnId: string;
    handles: string[];
    userId: string;
    text: string;
  },
): Promise<number> {
  const record: ReversalRecord = {
    documentId: input.docId,
    threadId: input.threadId,
    turnId: input.turnId,
    writeIds: input.handles,
    status: "reversed",
    undoUpdateSeq: 0,
    reversedAt: new Date("2026-06-21T00:00:00.000Z"),
    reversedByUserId: input.userId,
  };
  await journal.persistUndo(input.docId, appendText(doc, input.text), [record], {
    type: "user",
    userId: input.userId,
  });
  const [reversed] = await journal.mutationsForWrite(input.docId, input.threadId, input.handles[0]);
  const undoSeq = reversed?.undoUpdateSeq;
  if (undoSeq === undefined) throw new Error("expected reversed mutation undoUpdateSeq");
  return undoSeq;
}

async function persistRedoForUndo(
  journal: ReversalStore,
  doc: Y.Doc,
  docId: string,
  threadId: string,
  undoUpdateSeq: number,
  text: string,
): Promise<number> {
  const redo = await journal.persistRedo(
    docId,
    appendText(doc, text),
    { threadId, undoUpdateSeq },
    { origin: "system", seq: 0 },
  );
  expect(redo.consumed).toBe(true);
  if (redo.seq === undefined) throw new Error("expected redo seq");
  return redo.seq;
}

async function expectMutation(
  journal: ReversalStore,
  docId: string,
  threadId: string,
  handle: string,
  expected: {
    status: "active" | "reversed";
    createdSeq: number | undefined;
    undoUpdateSeq: number | undefined;
  },
): Promise<void> {
  const rows = await journal.mutationsForWrite(docId, threadId, handle);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    handle,
    status: expected.status,
    createdSeq: expected.createdSeq,
  });
  expect(rows[0]?.undoUpdateSeq).toBe(expected.undoUpdateSeq);
}

async function expectReversal(
  journal: ReversalStore,
  docId: string,
  threadId: string,
  handle: string,
  expected: {
    status: "reversed" | "redone";
    undoUpdateSeq: number;
    redoUpdateSeq: number | undefined;
  },
): Promise<void> {
  const rows = await journal.readReversals(docId, { threadId });
  const row = rows.find((record) => record.writeIds.includes(handle));
  expect(row).toMatchObject({
    writeIds: [handle],
    status: expected.status,
    undoUpdateSeq: expected.undoUpdateSeq,
  });
  expect(row?.redoUpdateSeq).toBe(expected.redoUpdateSeq);
}

function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(text.toString().length, value);
  return Y.encodeStateAsUpdate(doc, before);
}
