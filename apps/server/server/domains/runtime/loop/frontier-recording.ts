/**
 * The runtime's side of what the model was shown: handing a stored result's evidence to the
 * document side, and the lookups a tool call reads. The document side owns the rows, so a failed
 * hand-over is logged and leaves the block with no frontier, and a failed lookup is logged and
 * answers the empty frontier: what records next is conservative, never missing.
 */
import type { FrontierLookup } from "@meridian/agent-edit/integration";
import type { ProjectId, TurnBlockId } from "@meridian/contracts";
import {
  evidenceFrontiers,
  type ResultEvidence,
  TREE_NAMES_ROOM,
} from "../../../shared/model-evidence.js";
import { type EventSink, emitEvent, unknownToEventPayload } from "../../observability/index.js";
import type { DocumentEvidence, RecordedFrontier } from "../ports/document-evidence.js";

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
      frontiers: evidenceFrontiers(blockId, evidence),
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
  let rows: RecordedFrontier[] = [];
  return async () => {
    try {
      const ids = await blockIds();
      const carried = new Set(ids);
      rows = rows.filter((row) => carried.has(row.blockId));
      for (const id of loaded) if (!carried.has(id)) loaded.delete(id);
      const fresh = ids.filter((id) => !loaded.has(id));
      if (fresh.length > 0) {
        rows = [...rows, ...(await deps.documentEvidence.frontiersIn(TREE_NAMES_ROOM, fresh))].sort(
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
