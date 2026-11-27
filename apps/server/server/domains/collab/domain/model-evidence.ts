import type { ObservationFrontier } from "@meridian/agent-edit/integration";
import type { ThreadId, UserId } from "@meridian/contracts/runtime";
import type { FrontierRooms, ShownLink, StoredEvidence } from "../../../shared/model-evidence.js";

export type ForgottenRooms =
  | { room: string }
  | { accountId: UserId; documentIds: readonly string[] };

/**
 * What the model was shown of documents, kept for its next write: a frontier per result block
 * (the document state that block showed, per room) and the links it was shown. A frontier's key
 * is the result block's id, with no foreign key to the block; every lookup names the block ids it
 * asks about, so a row a crash left behind is never read. Order is insertion order: the loop
 * awaits each call before the next, so the latest row is the latest shown.
 */
export interface ModelEvidence {
  resultStored(evidence: StoredEvidence): Promise<void>;
  latestFrontier(
    documentId: string,
    blockIds: readonly string[],
  ): Promise<ObservationFrontier | null>;
  frontiersIn(
    rooms: FrontierRooms,
    blockIds: readonly string[],
  ): Promise<{ blockId: string; recordedSeq: number; snapshot: Uint8Array }[]>;
  forDocument(threadId: string, documentId: string): Promise<ShownLink[]>;
  forgetThreads(threadIds: readonly ThreadId[]): Promise<void>;
  forgetFrontiers(rooms: ForgottenRooms): Promise<void>;
}
