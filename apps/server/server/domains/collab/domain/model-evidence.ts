import type { ObservationFrontier } from "@meridian/agent-edit/integration";
import type { ThreadId } from "@meridian/contracts/runtime";
import type { ShownLink, StoredEvidence } from "../../../shared/model-evidence.js";

/**
 * What the model was shown of documents, kept for its next write: a frontier per result block
 * (the document state that block showed, per room) and the links it was shown. A frontier's key
 * is the result block's id, with no foreign key to the block; every lookup names the block ids it
 * asks about, so a row a crash left behind is never read. Order is insertion order: the loop
 * awaits each call before the next, so the latest row is the latest shown.
 */
export interface ModelEvidence {
  /**
   * Records `evidence`, replacing the frontier a block already holds. Joins an ambient
   * transaction: an edit records its own inside its command, a read's after its block is stored.
   */
  resultStored(evidence: StoredEvidence): Promise<void>;
  /** The latest-recorded frontier for `room` among `blockIds`, or null. */
  latestFrontier(room: string, blockIds: readonly string[]): Promise<ObservationFrontier | null>;
  /** Which of `rooms` the model saw most recently among `blockIds`: the room of the latest row. */
  latestRoom(rooms: readonly string[], blockIds: readonly string[]): Promise<string | null>;
  /** Own shown links plus, for a fork, its source's at turns up to its cutoff, recursively. */
  forDocument(threadId: string, documentId: string): Promise<ShownLink[]>;
  /** Deletes what these threads were shown and the tool results their model edits stored, when the threads are deleted. */
  forgetThreads(threadIds: readonly ThreadId[]): Promise<void>;
}
