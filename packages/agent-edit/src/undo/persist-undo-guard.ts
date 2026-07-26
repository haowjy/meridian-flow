// Authoritative undo dependency re-check immediately before persistence.
import type { JournalSnapshot, ReversalRecord } from "../ports/types.js";
import type { PersistUndoResult, ReversalStore, UpdateJournal } from "../ports/update-journal.js";
import {
  hasLaterWriterUpdateAfterWatermark,
  persistUndoPlanWatermark,
} from "./persist-undo-watermark.js";

/** Shared dependency-conflict copy for persist-time races and turn reversal. */
export const PERSIST_UNDO_DEPENDENT_MESSAGE =
  "This turn has later live edits depending on it. View the change instead of undoing it.";

type PersistUndoGuardStore = ReversalStore & Pick<UpdateJournal, "read">;

/**
 * Reject undo persistence when a non-system journal row lands after the plan-time
 * watermark. Structural dependency is checked during planning; this closes the
 * FG-9.2 race between planning and `persistUndo`.
 */
export async function guardPersistUndo(
  reversalStore: PersistUndoGuardStore,
  docId: string,
  records: readonly ReversalRecord[],
): Promise<PersistUndoResult | null> {
  if (records.length === 0) return null;
  const planWatermark = persistUndoPlanWatermark(records);
  if (planWatermark === 0) return null;
  const snapshot = await reversalStore.read(docId);
  if (!hasLaterWriterUpdateAfter(snapshot, planWatermark)) return null;
  return {
    persisted: false,
    status: "cant_undo_dependent",
    message: PERSIST_UNDO_DEPENDENT_MESSAGE,
  };
}

function hasLaterWriterUpdateAfter(snapshot: JournalSnapshot, afterSeq: number): boolean {
  return hasLaterWriterUpdateAfterWatermark(
    snapshot.updates.map((update) => ({ seq: update.seq, origin: update.meta.origin })),
    afterSeq,
  );
}
