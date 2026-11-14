/**
 * What the model was shown of documents, kept by the document side: the frontier each result
 * block showed (per room: `draft:<workDraftId>` or `live:<documentId>:<authorityGeneration>`) and
 * the links it was shown. The runtime never writes the tables. An edit's evidence is recorded by
 * the document side in the edit's own transaction; a read's, and a writer turn's reference
 * blocks', are handed over with `resultStored` once their blocks are stored. Every lookup names the
 * block ids it asks about: the blocks a request carries, never the whole conversation.
 */
import type {
  FrontierLookup,
  ObservationFrontier,
  ReplyMutations,
  StoredEvidence,
} from "../../../shared/model-evidence.js";

export interface DocumentEvidence {
  /** Records what stored blocks showed the model. Joins an ambient transaction. */
  resultStored(evidence: StoredEvidence): Promise<void>;
  /** The latest-recorded frontier for `room` among `blockIds`, or null. */
  latestFrontier(room: string, blockIds: readonly string[]): Promise<ObservationFrontier | null>;
  /** Every row for `room` among `blockIds`, oldest recorded first: the names shown. */
  frontiersIn(room: string, blockIds: readonly string[]): Promise<RecordedFrontier[]>;
}

/** One block's row in a room, with the order it was recorded in. */
export type RecordedFrontier = { blockId: string; recordedSeq: number; snapshot: Uint8Array };

/**
 * The lookups a tool call reads. `recording` is the run's current blocks: what
 * a result records chains from it, so a sibling call's result counts as seen.
 * `planning` is the blocks the authoring request was built from (C4): a call
 * plans on the model's view as of that request. `reply` is the provider reply's
 * own accepted mutations since then, which the view replays: the reply owns it
 * and clears it at its terminal boundary. `credited` is the `recording` blocks' ids,
 * for the document side's own queries.
 */
export interface FrontierLookups {
  recording: FrontierLookup;
  planning: FrontierLookup;
  credited(): readonly string[];
  reply: ReplyMutations;
}
