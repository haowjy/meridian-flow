/** Undo/redo availability derived from write mutation metadata and retained journal rows. */
import type { ReversalRecord } from "../ports/types.js";
import type { ActiveWriteSummary, UpdateJournal } from "../ports/update-journal.js";
import { evaluateRedoEligibility } from "./reconstruction.js";

type MutationQueries = Required<
  Pick<
    UpdateJournal,
    "latestActiveWrite" | "activeWriteSummary" | "writeMinCreatedSeq" | "mutationsForWrite"
  >
>;

export interface UndoAvailability {
  undo: boolean;
  redo: boolean;
  undoWriteId?: string;
  redoWriteId?: string;
}

export interface AvailabilityDetails extends UndoAvailability {
  redoTarget?: { writeId: string; turnId: string; undoUpdateSeq: number };
}

export async function resolveUndoAvailability(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
  now?: Date;
}): Promise<AvailabilityDetails> {
  const [undoWrite, redoTarget] = await Promise.all([
    latestUndoableWrite(input),
    latestRedoableTarget(input),
  ]);
  return {
    undo: undoWrite !== undefined,
    redo: redoTarget !== undefined,
    ...(undoWrite ? { undoWriteId: undoWrite.writeId } : {}),
    ...(redoTarget ? { redoWriteId: redoTarget.writeId, redoTarget } : {}),
  };
}

export async function latestUndoableWrite(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
}): Promise<{ writeId: string; turnId: string } | undefined> {
  const latest = await input.mutationQueries.latestActiveWrite(input.docId, input.threadId);
  if (!latest) return undefined;
  return (await journalStillHasWriteStart(input.journal, input.docId, latest))
    ? { writeId: latest.handle, turnId: latest.turnId }
    : undefined;
}

export async function specificUndoableWrite(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
  writeId: string;
}): Promise<{ writeId: string; turnId: string } | undefined> {
  const rows = await input.mutationQueries.mutationsForWrite(
    input.docId,
    input.threadId,
    input.writeId,
  );
  const active = rows.find((row) => row.status === "active");
  if (!active) return undefined;
  return (await journalStillHasWriteStart(input.journal, input.docId, active))
    ? { writeId: active.handle, turnId: active.turnId }
    : undefined;
}

export async function undoableWrites(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
}): Promise<{ writeId: string; turnId: string }[]> {
  const active = await input.mutationQueries.activeWriteSummary(input.docId, input.threadId);
  const retained = await Promise.all(
    active.map(async (row) =>
      (await journalStillHasWriteStart(input.journal, input.docId, row))
        ? { writeId: row.handle, turnId: row.turnId }
        : undefined,
    ),
  );
  return retained.filter((row): row is { writeId: string; turnId: string } => row !== undefined);
}

export async function latestRedoableTarget(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
  now?: Date;
}): Promise<{ writeId: string; turnId: string; undoUpdateSeq: number } | undefined> {
  const targets = await redoableTargets(input);
  return targets.at(-1);
}

export async function specificRedoableTarget(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
  writeId: string;
  now?: Date;
}): Promise<{ writeId: string; turnId: string; undoUpdateSeq: number } | undefined> {
  return (await redoableTargets(input)).find((target) => target.writeId === input.writeId);
}

export async function redoableTargets(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
  now?: Date;
}): Promise<{ writeId: string; turnId: string; undoUpdateSeq: number }[]> {
  const now = input.now ?? new Date();
  const records = (
    await input.journal.readReversals(input.docId, {
      threadId: input.threadId,
      status: ["reversed"],
    })
  )
    .filter((record) => !record.expiresAt || record.expiresAt > now)
    .sort(compareReversalStackOrder);
  const snapshot = await input.journal.read(input.docId, { fromCheckpoint: false });
  const output: { writeId: string; turnId: string; undoUpdateSeq: number }[] = [];
  for (const record of records) {
    if (!snapshotRetainsSeq(snapshot, record.undoUpdateSeq)) continue;
    const targetStartSeq = await input.mutationQueries.writeMinCreatedSeq(
      input.docId,
      input.threadId,
      record.writeId ?? record.turnId,
    );
    if (targetStartSeq === undefined) continue;
    if (!snapshotRetainsSeq(snapshot, targetStartSeq)) continue;
    if (!evaluateRedoEligibility(snapshot.updates, { undoUpdateSeq: record.undoUpdateSeq }).ok)
      continue;
    output.push({
      writeId: record.writeId ?? record.turnId,
      turnId: record.turnId,
      undoUpdateSeq: record.undoUpdateSeq,
    });
  }
  return output;
}

async function journalStillHasWriteStart(
  journal: UpdateJournal,
  docId: string,
  row: Pick<ActiveWriteSummary, "createdSeq">,
): Promise<boolean> {
  const snapshot = await journal.read(docId, {
    since: row.createdSeq,
    until: row.createdSeq,
    fromCheckpoint: false,
  });
  return snapshotRetainsSeq(snapshot, row.createdSeq);
}

function snapshotRetainsSeq(snapshot: { updates: { seq: number }[] }, seq: number): boolean {
  return snapshot.updates.some((update) => update.seq === seq);
}

function compareReversalStackOrder(left: ReversalRecord, right: ReversalRecord): number {
  const bySeq = left.undoUpdateSeq - right.undoUpdateSeq;
  if (bySeq !== 0) return bySeq;
  return (left.reversedAt?.getTime() ?? 0) - (right.reversedAt?.getTime() ?? 0);
}
