// Rebuilds the in-memory redo target stack from durable reversal records.
import type { ReversalRecord } from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { evaluateRedoEligibility } from "../undo/reconstruction.js";

export interface RehydratedRedoTarget {
  turnId: string;
  undoUpdateSeq: number;
}

export async function rehydrateRedoStack(input: {
  journal: UpdateJournal;
  docId: string;
  threadId: string;
  now?: Date;
}): Promise<RehydratedRedoTarget[]> {
  const now = input.now ?? new Date();
  const records = (
    await input.journal.readReversals(input.docId, {
      threadId: input.threadId,
      status: ["reversed"],
    })
  ).filter((record) => isRedoCandidate(record, now));
  if (records.length === 0) return [];

  const snapshot = await input.journal.read(input.docId);
  const updateSeqs = new Set(snapshot.updates.map((update) => update.seq));

  return records
    .filter(
      (record) =>
        updateSeqs.has(record.undoUpdateSeq) &&
        evaluateRedoEligibility(snapshot.updates, { undoUpdateSeq: record.undoUpdateSeq }).ok,
    )
    .sort(compareReversalRedoOrder)
    .map((record) => ({ turnId: record.turnId, undoUpdateSeq: record.undoUpdateSeq }));
}

function isRedoCandidate(record: ReversalRecord, now: Date): boolean {
  return (
    record.status === "reversed" &&
    record.undoUpdateSeq > 0 &&
    (record.expiresAt === undefined || record.expiresAt > now)
  );
}

function compareReversalRedoOrder(left: ReversalRecord, right: ReversalRecord): number {
  return (
    dateSortValue(left.reversedAt) - dateSortValue(right.reversedAt) ||
    left.undoUpdateSeq - right.undoUpdateSeq
  );
}

function dateSortValue(date: Date | undefined): number {
  return date?.getTime() ?? 0;
}
