/**
 * The runtime's side of what the model was shown: handing a stored result's evidence to the
 * document side, and the lookups a tool call reads. The document side owns the rows, so a failed
 * hand-over is logged and leaves the block with no frontier, and a failed lookup is logged and
 * answers the empty frontier: what records next is conservative, never missing.
 */
import type { FrontierLookup } from "@meridian/agent-edit/integration";
import type { ProjectId, TurnBlockId } from "@meridian/contracts";
import type { ResultEvidence } from "../../../shared/model-evidence.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { DocumentEvidence } from "../ports/document-evidence.js";

export interface FrontierRecordingDeps {
  documentEvidence: DocumentEvidence;
  eventSink: EventSink;
}

/** A read's evidence, handed over once the block that showed it is stored. */
export async function recordStoredResult(
  deps: FrontierRecordingDeps,
  owner: { projectId: ProjectId; threadId: string; turnId: string },
  blockId: TurnBlockId,
  evidence: ResultEvidence,
): Promise<void> {
  try {
    await deps.documentEvidence.resultStored({
      ...owner,
      shown: evidence.shown,
      frontiers: evidence.frontier ? [{ blockId, frontier: evidence.frontier }] : [],
    });
  } catch (error) {
    emitEvent(deps.eventSink, {
      level: "warn",
      source: "runtime.orchestrator",
      name: "observation_frontier.record_failed",
      correlation: { threadId: owner.threadId, turnId: owner.turnId },
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

/** The model's latest frontier for a room among `blockIds`, read when called. */
export function frontierLookup(
  deps: FrontierRecordingDeps,
  blockIds: () => readonly TurnBlockId[] | Promise<readonly TurnBlockId[]>,
  correlation: { threadId: string; turnId: string },
): FrontierLookup {
  return async (room) => {
    try {
      return await deps.documentEvidence.latestFrontier(room, await blockIds());
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
