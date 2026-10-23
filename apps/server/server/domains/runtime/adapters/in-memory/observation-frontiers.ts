/**
 * In-memory `ObservationFrontiers`: the same remove, insert and latest-by-recording
 * semantics as the Drizzle adapter. Rows join the repositories' transaction
 * owner, so a frontier recorded with a result that fails to persist rolls back
 * with it. Rows are not removed with their block; a test deletes no blocks.
 */
import type { ObservationFrontier } from "@meridian/agent-edit/integration";
import type { InMemoryTransactionOwner } from "../../../../shared/in-memory-transaction.js";
import type { ObservationFrontiers } from "../../ports/observation-frontiers.js";

interface Row extends ObservationFrontier {
  recordedSeq: number;
}

export function createInMemoryObservationFrontiers(deps: {
  /** The owner the thread repositories commit through. */
  transactionOwner: InMemoryTransactionOwner;
}): ObservationFrontiers {
  const rows = deps.transactionOwner.map<string, Row>();
  let seq = 0;
  return {
    async remove(sourceBlockId) {
      rows.delete(sourceBlockId);
    },
    async insert(sourceBlockId, frontier) {
      rows.set(sourceBlockId, {
        room: frontier.room,
        snapshot: frontier.snapshot.slice(),
        ...(frontier.position === undefined ? {} : { position: frontier.position }),
        recordedSeq: ++seq,
      });
    },
    async latest(room, sourceBlockIds) {
      let latest: Row | undefined;
      for (const id of sourceBlockIds) {
        const row = rows.get(id);
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
  };
}
