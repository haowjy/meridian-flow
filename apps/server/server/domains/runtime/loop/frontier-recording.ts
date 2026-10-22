/**
 * Records observation frontiers with the transcript block that showed them and
 * builds frontier lookups. Clearing a block's old row is part of writing the
 * block and fails it; recording the new row never does: the store isolates its
 * insert in a savepoint, and a failure is logged and leaves the block with no
 * frontier.
 */
import type { FrontierLookup, ObservationFrontier } from "@meridian/agent-edit/integration";
import type { TurnBlockId } from "@meridian/contracts";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { ObservationFrontiers } from "../ports/observation-frontiers.js";

export interface FrontierRecordingDeps {
  observationFrontiers: ObservationFrontiers;
  eventSink: EventSink;
}

/**
 * Replace a block's frontier inside the transaction persisting it, after its
 * row is projected (`afterEvents`). A result whose content was replaced always
 * calls this, with none when its new rendering records no frontier.
 */
export async function recordFrontier(
  deps: FrontierRecordingDeps,
  sourceBlockId: TurnBlockId,
  frontier: ObservationFrontier | undefined,
  correlation: { threadId: string; turnId: string },
): Promise<void> {
  await deps.observationFrontiers.remove(sourceBlockId);
  if (!frontier) return;
  try {
    await deps.observationFrontiers.insert(sourceBlockId, frontier);
  } catch (error) {
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "runtime.orchestrator",
      name: "observation_frontier.record_failed",
      correlation,
      payload: unknownToEventPayload(error),
    });
  }
}

/**
 * The block ids whose frontier rows may credit the model: the blocks its request
 * carries (C10), not the whole effective conversation. The run reseeds it from
 * each request's projection and appends the results that persist after.
 */
export class CreditedBlocks {
  #ids: Set<string>;

  constructor(ids: Iterable<string> = []) {
    this.#ids = new Set(ids);
  }

  reset(ids: Iterable<string>): void {
    this.#ids = new Set(ids);
  }

  add(id: string): void {
    this.#ids.add(id);
  }

  ids(): string[] {
    return [...this.#ids];
  }
}

/**
 * The model's latest frontier for a room among `blockIds`, read when called.
 * A failed lookup is logged and answers null, the empty frontier, so what
 * records next is conservative rather than missing.
 */
export function frontierLookup(
  deps: FrontierRecordingDeps,
  blockIds: () => readonly TurnBlockId[] | Promise<readonly TurnBlockId[]>,
  correlation: { threadId: string; turnId: string },
): FrontierLookup {
  return async (room) => {
    try {
      return await deps.observationFrontiers.latest(room, await blockIds());
    } catch (error) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "runtime.orchestrator",
        name: "observation_frontier.lookup_failed",
        correlation,
        payload: unknownToEventPayload(error),
      });
      return null;
    }
  };
}
