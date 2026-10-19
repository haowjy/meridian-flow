/** PostgreSQL `ObservationFrontiers` over `observation_frontiers`. */
import * as schema from "@meridian/database/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  currentDrizzleDb,
  type DrizzleDatabase,
  runInDrizzleSavepoint,
  runIsolatedFromAmbientTransaction,
} from "../../../../shared/drizzle-transaction.js";
import type { ObservationFrontiers } from "../../ports/observation-frontiers.js";

export function createDrizzleObservationFrontiers(db: DrizzleDatabase): ObservationFrontiers {
  const db_ = () => currentDrizzleDb(db);
  const table = schema.observationFrontiers;
  return {
    async remove(sourceBlockId) {
      await db_().delete(table).where(eq(table.sourceBlockId, sourceBlockId));
    },
    async insert(sourceBlockId, frontier) {
      await runInDrizzleSavepoint(db, () =>
        db_()
          .insert(table)
          .values({
            sourceBlockId,
            roomKey: frontier.room,
            snapshot: Buffer.from(frontier.snapshot),
            unshown: [...frontier.unshown],
          }),
      );
    },
    async latest(room, sourceBlockIds) {
      if (sourceBlockIds.length === 0) return null;
      // One text parameter, not one per block: a long conversation has thousands. Compared as
      // text, so a block id that is not a UUID matches nothing instead of failing the cast.
      // The ordering spells the index's (`room_key, recorded_seq DESC NULLS LAST`) so the scan
      // walks the room newest first and stops at the first row among these blocks.
      const [row] = await runIsolatedFromAmbientTransaction(db, () =>
        db_()
          .select({ snapshot: table.snapshot, unshown: table.unshown })
          .from(table)
          .where(
            and(
              eq(table.roomKey, room),
              sql`${table.sourceBlockId}::text = ANY(string_to_array(${sourceBlockIds.join(",")}, ','))`,
            ),
          )
          .orderBy(sql`${table.recordedSeq} DESC NULLS LAST`)
          .limit(1),
      );
      return row ? { room, snapshot: new Uint8Array(row.snapshot), unshown: row.unshown } : null;
    },
  };
}
