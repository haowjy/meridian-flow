/**
 * In-memory `ObservationFrontiers`: the same replace and latest-by-recording
 * semantics as the Drizzle adapter. Rows join the repositories' transaction
 * owner, so a frontier recorded with a result that fails to persist rolls back
 * with it. Rows are not removed with their block; a test deletes no blocks.
 */
import type { InMemoryTransactionOwner } from "../../../../shared/in-memory-transaction.js";
import type { ObservationFrontiers, RoomFrontier } from "../../ports/observation-frontiers.js";

interface Row extends RoomFrontier {
  sourceBlockId: string;
  recordedSeq: number;
}

export function createInMemoryObservationFrontiers(deps: {
  /** The owner the thread repositories commit through. */
  transactionOwner: InMemoryTransactionOwner;
}): ObservationFrontiers {
  const rows = deps.transactionOwner.map<string, Row>();
  let seq = 0;
  return {
    async replace(sourceBlockId, frontiers) {
      for (const [key, row] of rows) if (row.sourceBlockId === sourceBlockId) rows.delete(key);
      for (const frontier of frontiers) {
        rows.set(JSON.stringify([sourceBlockId, frontier.roomKey]), {
          sourceBlockId,
          roomKey: frontier.roomKey,
          snapshot: frontier.snapshot.slice(),
          unshown: [...frontier.unshown],
          recordedSeq: ++seq,
        });
      }
    },
    async latest(roomKey, sourceBlockIds) {
      const ids = new Set(sourceBlockIds);
      let latest: Row | undefined;
      for (const row of rows.values()) {
        if (row.roomKey !== roomKey || !ids.has(row.sourceBlockId)) continue;
        if (!latest || row.recordedSeq > latest.recordedSeq) latest = row;
      }
      return latest ? { snapshot: latest.snapshot.slice(), unshown: [...latest.unshown] } : null;
    },
  };
}
