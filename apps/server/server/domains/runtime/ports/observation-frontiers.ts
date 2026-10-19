/**
 * Observation frontiers: what document state each transcript block showed the
 * model, per room (`draft:<workDraftId>` or `live:<documentId>:<authorityGeneration>`).
 * A tool result or a writer turn's reference block records at most one, for
 * the room it rendered from, in the transaction that persists the block. The
 * model's frontier for a room is the latest-recorded row among a
 * conversation's blocks: rooms only grow (gc-off), so recording order is cut
 * order. Nothing is copied at fork time; a fork reads the inherited blocks'
 * rows by their ids.
 */
import type {
  FrontierLookup,
  ObservationFrontier,
  ReplyMutations,
} from "@meridian/agent-edit/integration";
import type { TurnBlockId } from "@meridian/contracts";

export interface ObservationFrontiers {
  /**
   * Delete the row a block holds. Part of the caller's block write, in its
   * transaction: a failure propagates.
   */
  remove(sourceBlockId: TurnBlockId): Promise<void>;
  /**
   * Insert a block's row in a savepoint: a failure throws without aborting the
   * caller's transaction, and the block keeps no row.
   */
  insert(sourceBlockId: TurnBlockId, frontier: ObservationFrontier): Promise<void>;
  /**
   * The latest-recorded row for `room` among `sourceBlockIds`, or null. In a
   * savepoint inside a transaction, so a failure leaves the caller's usable.
   */
  latest(room: string, sourceBlockIds: readonly TurnBlockId[]): Promise<ObservationFrontier | null>;
}

/**
 * The lookups a tool call reads. `recording` is the run's current blocks: what
 * a result records chains from it, so a sibling call's result counts as seen.
 * `planning` is the blocks the authoring request was built from (C4): a call
 * plans on the model's view as of that request. `reply` is the provider reply's
 * own accepted mutations since then, which the view replays: the reply owns it
 * and clears it at its terminal boundary.
 */
export interface FrontierLookups {
  recording: FrontierLookup;
  planning: FrontierLookup;
  reply: ReplyMutations;
}
