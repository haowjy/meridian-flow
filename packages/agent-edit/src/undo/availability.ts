/** Undo/redo availability derived from mutation metadata and retained journal rows. */
import type { ReversalRecord } from "../ports/types.js";
import type { UpdateJournal } from "../ports/update-journal.js";
import { evaluateRedoEligibility } from "./reconstruction.js";

type MutationQueries = Pick<
  UpdateJournal,
  "latestActiveTurn" | "activeTurnSummary" | "turnMinCreatedSeq"
>;

export interface UndoAvailability {
  undo: boolean;
  redo: boolean;
  undoTurnId?: string;
  redoTurnId?: string;
}

export interface AvailabilityDetails extends UndoAvailability {
  redoTarget?: {
    turnId: string;
    undoUpdateSeq: number;
  };
}

export async function resolveUndoAvailability(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
}): Promise<AvailabilityDetails> {
  const [undoTurnId, redoTarget] = await Promise.all([
    latestUndoableTurn(input),
    latestRedoableTarget(input),
  ]);
  return {
    undo: undoTurnId !== undefined,
    redo: redoTarget !== undefined,
    ...(undoTurnId ? { undoTurnId } : {}),
    ...(redoTarget ? { redoTurnId: redoTarget.turnId, redoTarget } : {}),
  };
}

export async function latestUndoableTurn(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
}): Promise<string | undefined> {
  const latestTurnId = await input.mutationQueries.latestActiveTurn(input.docId, input.threadId);
  if (!latestTurnId) return undefined;

  const summaries = await input.mutationQueries.activeTurnSummary(input.docId, input.threadId);
  const latest = summaries.find((summary) => summary.turnId === latestTurnId);
  if (!latest) return undefined;

  return (await journalStillHasTurnStart(input.journal, input.docId, latestTurnId, latest.minSeq))
    ? latestTurnId
    : undefined;
}

export async function latestRedoableTarget(input: {
  journal: UpdateJournal;
  mutationQueries: MutationQueries;
  docId: string;
  threadId: string;
}): Promise<{ turnId: string; undoUpdateSeq: number } | undefined> {
  const records = (
    await input.journal.readReversals(input.docId, {
      threadId: input.threadId,
      status: ["reversed"],
    })
  ).sort(compareReversalStackOrder);
  const latest = records.at(-1);
  if (!latest) return undefined;

  const snapshot = await input.journal.read(input.docId);
  const undoUpdate = snapshot.updates.find((update) => update.seq === latest.undoUpdateSeq);
  if (!undoUpdate) return undefined;

  const targetTurnStartSeq = await input.mutationQueries.turnMinCreatedSeq(
    input.docId,
    input.threadId,
    latest.turnId,
  );
  if (targetTurnStartSeq === undefined) return undefined;
  const targetTurnStartStillRetained = snapshot.updates.some(
    (update) => update.seq === targetTurnStartSeq && update.meta.actorTurnId === latest.turnId,
  );
  if (!targetTurnStartStillRetained) return undefined;

  return evaluateRedoEligibility(snapshot.updates, { undoUpdateSeq: latest.undoUpdateSeq }).ok
    ? { turnId: latest.turnId, undoUpdateSeq: latest.undoUpdateSeq }
    : undefined;
}

async function journalStillHasTurnStart(
  journal: UpdateJournal,
  docId: string,
  turnId: string,
  seq: number,
): Promise<boolean> {
  const snapshot = await journal.read(docId, { since: seq, until: seq });
  return snapshot.updates.some(
    (update) => update.seq === seq && update.meta.actorTurnId === turnId,
  );
}

function compareReversalStackOrder(left: ReversalRecord, right: ReversalRecord): number {
  const bySeq = left.undoUpdateSeq - right.undoUpdateSeq;
  if (bySeq !== 0) return bySeq;
  return (left.reversedAt?.getTime() ?? 0) - (right.reversedAt?.getTime() ?? 0);
}
