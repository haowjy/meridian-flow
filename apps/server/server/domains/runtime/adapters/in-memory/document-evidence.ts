/**
 * In-memory `DocumentEvidence` for runtime tests: the same per-turn shown-link rows, dedup and
 * fork lineage, and the same latest-by-recording frontiers, as the document side's Postgres
 * store. Rows join the repositories' transaction owner, so evidence recorded with blocks that
 * fail to persist rolls back with them. Rows are not removed with their block; a test deletes
 * no blocks.
 */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { InMemoryTransactionOwner } from "../../../../shared/in-memory-transaction.js";
import {
  latestShowings,
  linkViewKey,
  type ObservationFrontier,
  type ShownLink,
  shownLinkLineage,
} from "../../../../shared/model-evidence.js";
import type { ThreadRepository, TurnRepository } from "../../../threads/index.js";
import type { DocumentEvidence } from "../../ports/document-evidence.js";

interface LinkRow extends ShownLink {
  threadId: string;
  documentId: string;
  turnId: string;
}

interface FrontierRow extends ObservationFrontier {
  recordedSeq: number;
}

export function createInMemoryDocumentEvidence(deps: {
  /** The owner the thread repositories commit through. */
  transactionOwner: InMemoryTransactionOwner;
  threads: Pick<ThreadRepository, "findByIdIncludingDeleted">;
  turns: Pick<TurnRepository, "findById">;
}): DocumentEvidence & {
  forDocument(threadId: string, documentId: string): Promise<ShownLink[]>;
} {
  const links = deps.transactionOwner.map<string, LinkRow>();
  const frontiers = deps.transactionOwner.map<string, FrontierRow>();
  let seq = 0;
  let frontierSeq = 0;
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
    async resultStored(evidence) {
      for (const { blockId, frontier } of evidence.frontiers)
        frontiers.set(blockId, {
          room: frontier.room,
          snapshot: frontier.snapshot.slice(),
          ...(frontier.position === undefined ? {} : { position: frontier.position }),
          recordedSeq: ++frontierSeq,
        });
      for (const showing of evidence.shown) {
        const view = linkViewKey(showing.view);
        for (const link of showing.links) {
          const row: LinkRow = {
            threadId: evidence.threadId,
            documentId: showing.documentId,
            turnId: evidence.turnId,
            ref: link.ref,
            address: link.address,
            holderUri: showing.holderUri,
            view,
            at: ++seq,
          };
          links.set(
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
      }
    },
    async latestFrontier(room, blockIds) {
      let latest: FrontierRow | undefined;
      for (const id of blockIds) {
        const row = frontiers.get(id);
        if (row?.room === room && (!latest || row.recordedSeq > latest.recordedSeq)) latest = row;
      }
      return latest
        ? {
            room,
            snapshot: latest.snapshot.slice(),
            ...(latest.position === undefined ? {} : { position: latest.position }),
          }
        : null;
    },
    async forDocument(threadId, documentId) {
      const lineage = await shownLinkLineage(threadId as ThreadId, lookup);
      const seen: ShownLink[] = [];
      for (const segment of lineage) {
        for (const row of links.values()) {
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
