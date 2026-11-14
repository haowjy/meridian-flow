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
import {
  type ObservationFrontiers,
  type ObservationRow,
  TREE_NAMES_ROOM,
} from "../ports/observation-frontiers.js";

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
  names?: ObservationFrontier,
): Promise<void> {
  await deps.observationFrontiers.remove(sourceBlockId);
  try {
    if (frontier) await deps.observationFrontiers.insert(sourceBlockId, frontier);
    if (names) await deps.observationFrontiers.insert(sourceBlockId, names);
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
 * What the blocks the run carries showed of the tree: each row's added names, oldest first. Rows
 * are read once per block for the life of the lookup (a block's rows do not change while the run
 * carries it), so a call reads only the blocks added since the one before. A failed lookup is
 * logged and answers nothing shown, which guards nothing.
 */
export function shownNamesLookup(
  deps: FrontierRecordingDeps,
  blockIds: () => readonly TurnBlockId[] | Promise<readonly TurnBlockId[]>,
  correlation: { threadId: string; turnId: string },
): () => Promise<Uint8Array[]> {
  const loaded = new Set<TurnBlockId>();
  let rows: ObservationRow[] = [];
  return async () => {
    try {
      const ids = await blockIds();
      const carried = new Set(ids);
      rows = rows.filter((row) => carried.has(row.sourceBlockId));
      for (const id of loaded) if (!carried.has(id)) loaded.delete(id);
      const fresh = ids.filter((id) => !loaded.has(id));
      if (fresh.length > 0) {
        rows = [...rows, ...(await deps.observationFrontiers.all(TREE_NAMES_ROOM, fresh))].sort(
          (a, b) => a.recordedSeq - b.recordedSeq,
        );
        for (const id of fresh) loaded.add(id);
      }
      return rows.map((row) => row.snapshot);
    } catch (error) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "runtime.orchestrator",
        name: "observation_frontier.lookup_failed",
        correlation,
        payload: unknownToEventPayload(error),
      });
      return [];
    }
  };
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
