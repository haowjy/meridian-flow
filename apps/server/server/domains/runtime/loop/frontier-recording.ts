import {
  type AgentEditResultV1,
  type FrontierLookup,
  isAgentEditResultEnvelope,
  type ShownBlock,
} from "@meridian/agent-edit/integration";
import type { ProjectId, TurnBlockId } from "@meridian/contracts";
import type { Block } from "@meridian/contracts/threads";
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
        rows = [
          ...rows,
          ...(await deps.documentEvidence.frontiersIn({ room: TREE_NAMES_ROOM }, fresh)),
        ].sort((a, b) => a.recordedSeq - b.recordedSeq);
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

export function frontierLookup(
  deps: FrontierRecordingDeps,
  blockIds: () => readonly TurnBlockId[] | Promise<readonly TurnBlockId[]>,
  correlation: { threadId: string; turnId: string },
): FrontierLookup {
  return async (documentId) => {
    try {
      return await deps.documentEvidence.latestFrontier(documentId, await blockIds());
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

export function shownLookup(
  deps: FrontierRecordingDeps,
  blockIds: () => readonly TurnBlockId[] | Promise<readonly TurnBlockId[]>,
  blocks: () => readonly Block[],
  correlation: { threadId: string; turnId: string },
): (documentId: string) => Promise<ShownBlock[]> {
  return async (documentId) => {
    try {
      const rows = await deps.documentEvidence.frontiersIn({ documentId }, await blockIds());
      const byId = new Map(blocks().map((block) => [block.id as string, block]));
      return rows.flatMap((row) => shownIn(byId.get(row.blockId)));
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

function shownIn(block: Block | undefined): ShownBlock[] {
  const content = block?.content as { result?: unknown; read?: { result?: unknown } } | undefined;
  const result = [content?.result, content?.read?.result].find(isAgentEditResultEnvelope) as
    | AgentEditResultV1
    | undefined;
  if (!result?.blocks) return [];
  return result.blocks.flatMap((group) =>
    group.extent === "full"
      ? group.items.map((item) => ({ hash: item.hash, body: item.body }))
      : [],
  );
}
