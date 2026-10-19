/**
 * Observation frontiers: what document state each transcript block showed the
 * model, per room (`draft:<workDraftId>` or `live:<documentId>:<authorityGeneration>`).
 * A tool result or a writer turn's reference block records one per room it
 * rendered, in the transaction that persists the block. The model's frontier
 * for a room is the latest-recorded row among a conversation's blocks: rooms
 * only grow (gc-off), so recording order is cut order. Nothing is copied at
 * fork time; a fork reads the inherited blocks' rows by their ids.
 */
import type { ObservationFrontier } from "@meridian/agent-edit/integration";

/** One room's frontier, as a block records it. */
export interface RoomFrontier extends ObservationFrontier {
  roomKey: string;
}

export interface ObservationFrontiers {
  /**
   * Replace the block's rows with `frontiers` (none: delete only). The delete
   * runs in the caller's transaction; the insert in a savepoint, so a failed
   * insert throws without aborting the caller and leaves the block with no rows.
   */
  replace(sourceBlockId: string, frontiers: readonly RoomFrontier[]): Promise<void>;
  /** The latest-recorded row for `roomKey` among `sourceBlockIds`, or null. */
  latest(roomKey: string, sourceBlockIds: readonly string[]): Promise<ObservationFrontier | null>;
}

/**
 * The frontier lookups a tool call reads. `recording` is the run's current
 * blocks: what a result records chains from it, so a sibling call's result
 * counts as seen. `planning` is the blocks the authoring request was built
 * from (C4): a call plans on the model's view as of that request. Neither
 * throws: an unavailable frontier is null, the empty one.
 */
export interface FrontierLookups {
  recording(roomKey: string): Promise<ObservationFrontier | null>;
  planning(roomKey: string): Promise<ObservationFrontier | null>;
}
