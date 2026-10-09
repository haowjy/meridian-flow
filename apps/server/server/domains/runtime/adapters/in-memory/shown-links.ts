/** In-memory `ShownLinkStore`: the same per-turn rows, dedup and fork lineage as the Drizzle adapter. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { ThreadRepository, TurnRepository } from "../../../threads/index.js";
import {
  latestShowings,
  linkViewKey,
  type ShownLink,
  type ShownLinkStore,
  shownLinkLineage,
} from "../../ports/shown-links.js";

interface Row extends ShownLink {
  threadId: string;
  documentId: string;
  turnId: string;
}

export function createInMemoryShownLinkStore(deps: {
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  turns: Pick<TurnRepository, "findById">;
}): ShownLinkStore {
  const rows = new Map<string, Row>();
  let seq = 0;
  const lookup = {
    async thread(threadId: ThreadId) {
      const thread = await deps.threads.findByIdIncludingDeleted(threadId);
      return thread
        ? { originType: thread.originType ?? null, originTurnId: thread.originTurnId ?? null }
        : null;
    },
    async turn(turnId: string) {
      const turn = await deps.turns.findById(turnId as TurnId);
      return turn ? { threadId: turn.threadId, position: turn.position } : null;
    },
  };
  return {
    async record(input) {
      const view = linkViewKey(input.view);
      for (const link of input.links) {
        const row: Row = {
          threadId: input.threadId,
          documentId: input.documentId,
          turnId: input.turnId,
          ref: link.ref,
          address: link.address,
          holderUri: input.holderUri,
          view,
          at: ++seq,
        };
        rows.set(
          JSON.stringify([
            row.threadId,
            row.documentId,
            row.ref,
            row.address,
            row.holderUri,
            view,
            row.turnId,
          ]),
          row,
        );
      }
    },
    async forDocument(threadId, documentId) {
      const lineage = await shownLinkLineage(threadId as ThreadId, lookup);
      const seen: ShownLink[] = [];
      for (const segment of lineage) {
        for (const row of rows.values()) {
          if (row.threadId !== segment.threadId || row.documentId !== documentId) continue;
          if (segment.maxPosition !== null) {
            const turn = await lookup.turn(row.turnId);
            if (!turn || turn.position > segment.maxPosition) continue;
          }
          seen.push({
            ref: row.ref,
            address: row.address,
            holderUri: row.holderUri,
            view: row.view,
            at: row.at,
          });
        }
      }
      return latestShowings(seen);
    },
  };
}
