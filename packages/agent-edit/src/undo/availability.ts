/** Undo/redo availability derived from the canonical reversal planner. */
import type { ReversalStore } from "../ports/update-journal.js";
import { planRedo, planUndo } from "./reversal-plan.js";

export interface UndoAvailability {
  undo: boolean;
  redo: boolean;
  undoWriteId?: string;
  redoWriteId?: string;
}

export interface AvailabilityDetails extends UndoAvailability {
  redoTarget?: { writeIds: string[]; turnId: string; undoUpdateSeq: number };
}

export async function resolveUndoAvailability(input: {
  reversalStore: ReversalStore;
  docId: string;
  threadId: string;
  now?: Date;
}): Promise<AvailabilityDetails> {
  const [undo, redo] = await Promise.all([
    planUndo({
      reversalStore: input.reversalStore,
      docId: input.docId,
      threadId: input.threadId,
      selection: { kind: "latest" },
    }),
    planRedo({
      reversalStore: input.reversalStore,
      docId: input.docId,
      threadId: input.threadId,
      selection: { kind: "latest" },
      now: input.now,
    }),
  ]);
  const undoRetained =
    undo.ok &&
    (await selectedWritesRetained(input.reversalStore, input.docId, input.threadId, undo.writeIds));
  const redoRetained =
    redo.ok &&
    (await selectedWritesRetained(input.reversalStore, input.docId, input.threadId, redo.writeIds));
  return {
    undo: undoRetained,
    redo: redoRetained,
    ...(undo.ok && undoRetained ? { undoWriteId: undo.writeIds.at(-1) } : {}),
    ...(redo.ok && redoRetained
      ? {
          redoWriteId: redo.writeIds[0],
          redoTarget: {
            writeIds: redo.writeIds,
            turnId: redo.turnId,
            undoUpdateSeq: redo.redoGroup?.undoUpdateSeq ?? 0,
          },
        }
      : {}),
  };
}

async function selectedWritesRetained(
  reversalStore: ReversalStore,
  docId: string,
  threadId: string,
  writeIds: readonly string[],
): Promise<boolean> {
  const snapshot = await reversalStore.readForReconstruction(docId);
  for (const writeId of writeIds) {
    const seq = await reversalStore.writeMinCreatedSeq(docId, threadId, writeId);
    if (seq === undefined || !snapshot.updates.some((update) => update.seq === seq)) return false;
  }
  return true;
}
