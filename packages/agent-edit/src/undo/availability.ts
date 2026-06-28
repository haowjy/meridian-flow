/** Undo/redo availability derived from the canonical reversal planner. */
import type { ReversalStore } from "../ports/update-journal.js";
import { planRedo, planUndo } from "./reversal-plan.js";

export interface UndoAvailability {
  undo: boolean;
  redo: boolean;
  undoWriteId?: string;
  redoWriteId?: string;
  undoTarget?: { writeIds: string[]; turnId: string };
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
  return {
    undo: undo.ok,
    redo: redo.ok,
    ...(undo.ok
      ? {
          undoWriteId: undo.writeIds.at(-1),
          ...(undo.writeIds.length > 1
            ? { undoTarget: { writeIds: undo.writeIds, turnId: undo.turnId } }
            : {}),
        }
      : {}),
    ...(redo.ok
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
