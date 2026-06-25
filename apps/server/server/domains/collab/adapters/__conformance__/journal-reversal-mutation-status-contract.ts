import type { ReversalStore, UpdateJournal } from "@meridian/agent-edit";
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

  const undoUpdate = appendText(doc, " Undo");
  const record = {
    documentId: docId,
    threadId,
    turnId: turnIds[0],
    writeIds: ["w1"],
    status: "reversed" as const,
    undoUpdateSeq: 0,
    reversedAt: new Date("2026-06-21T00:00:00.000Z"),
    reversedByUserId: userId,
  };
  await journal.persistUndo(docId, undoUpdate, [record], { type: "user", userId });
  const [reversedFirst] = await journal.mutationsForWrite(docId, threadId, "w1");
  const undoSeq = reversedFirst?.undoUpdateSeq;
  if (undoSeq === undefined) throw new Error("expected reversed mutation undoUpdateSeq");
  expect(undoSeq).toBeGreaterThan(second?.seq ?? 0);
  await expectMutation(journal, docId, threadId, "w1", {
    status: "reversed",
    createdSeq: first?.seq,
    undoUpdateSeq: undoSeq,
  });
  await expectMutation(journal, docId, threadId, "w2", {
    status: "active",
    createdSeq: second?.seq,
    undoUpdateSeq: undefined,
  });

  const redo = await journal.persistRedo(
    docId,
    appendText(doc, " Redo"),
    { threadId, undoUpdateSeq: undoSeq },
    { origin: "system", seq: 0 },
  );
  expect(redo.consumed).toBe(true);
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
  expect(await journal.readReversals(docId, { threadId, status: ["redone"] })).toMatchObject([
    { turnId: turnIds[0], status: "redone" },
  ]);
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

function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(text.toString().length, value);
  return Y.encodeStateAsUpdate(doc, before);
}
