/**
 * Records observation frontiers with the transcript block that showed them and
 * builds the tool call's frontier lookups. Recording never fails the block:
 * the store isolates its insert in a savepoint, and a failure is logged and
 * leaves the block with no frontier.
 */
import type { Block } from "@meridian/contracts/threads";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type {
  FrontierLookups,
  ObservationFrontiers,
  RoomFrontier,
} from "../ports/observation-frontiers.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface FrontierRecordingDeps {
  observationFrontiers: ObservationFrontiers;
  eventSink: EventSink;
}

/**
 * Replace a block's frontiers inside the transaction persisting it, after its
 * row is projected (`afterEvents`). A result whose content was replaced always
 * calls this, with none when its new rendering showed no document.
 */
export async function recordFrontiers(
  deps: FrontierRecordingDeps,
  sourceBlockId: string,
  frontiers: readonly RoomFrontier[],
  correlation: { threadId: string; turnId: string },
): Promise<void> {
  try {
    await deps.observationFrontiers.replace(sourceBlockId, frontiers);
  } catch (error) {
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "runtime.orchestrator",
      name: "observation_frontier.record_failed",
      correlation,
      payload: { frontierCount: frontiers.length, ...unknownToEventPayload(error) },
    });
  }
}

/**
 * The lookups over two block sets: `recording` reads the run's blocks as they
 * are when it is called, `planning` the blocks the authoring request was built
 * from. A failed lookup is logged and answers null, the empty frontier, so
 * what records next is conservative rather than missing.
 */
export function frontierLookups(
  deps: FrontierRecordingDeps,
  recordingBlocks: () => readonly Block[],
  planningBlockIds: readonly string[],
  correlation: { threadId: string; turnId: string },
): FrontierLookups {
  const latest = async (roomKey: string, ids: readonly string[]) => {
    try {
      return await deps.observationFrontiers.latest(roomKey, ids);
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
  return {
    recording: (roomKey) =>
      latest(roomKey, persistedIds(recordingBlocks().map((block) => block.id))),
    planning: (roomKey) => latest(roomKey, persistedIds(planningBlockIds)),
  };
}

/** Only persisted rows hold frontiers; a block's id is a UUID once it is. */
function persistedIds(ids: readonly string[]): string[] {
  return ids.filter((id) => UUID.test(id));
}
