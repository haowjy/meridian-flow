/** PostgreSQL `ObservationFrontiers` over `observation_frontiers`. */
import type { TurnBlockId } from "@meridian/contracts";
import * as schema from "@meridian/database/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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
    async remove(sourceBlockIds, roomKey) {
      if (sourceBlockIds.length === 0) return;
      await db_()
        .delete(table)
        .where(
          and(
            inArray(table.sourceBlockId, sourceBlockIds as TurnBlockId[]),
            roomKey === undefined ? undefined : eq(table.roomKey, roomKey),
          ),
        );
    },
    async insert(sourceBlockId, frontiers) {
      if (frontiers.length === 0) return;
      await runInDrizzleSavepoint(db, () =>
        db_()
          .insert(table)
          .values(
            frontiers.map((frontier) => ({
              sourceBlockId: sourceBlockId as TurnBlockId,
              roomKey: frontier.roomKey,
              snapshot: Buffer.from(frontier.snapshot),
              unshown: [...frontier.unshown],
            })),
          ),
      );
    },
    async latest(roomKey, sourceBlockIds) {
      if (sourceBlockIds.length === 0) return null;
      // One text parameter, not one per block: a long conversation has thousands.
      const [row] = await runIsolatedFromAmbientTransaction(db, () =>
        db_()
          .select({ snapshot: table.snapshot, unshown: table.unshown })
          .from(table)
          .where(
            and(
              eq(table.roomKey, roomKey),
              sql`${table.sourceBlockId} = ANY(string_to_array(${sourceBlockIds.join(",")}, ',')::uuid[])`,
            ),
          )
          .orderBy(desc(table.recordedSeq))
          .limit(1),
      );
      return row ? { snapshot: new Uint8Array(row.snapshot), unshown: row.unshown } : null;
    },
  };
}
