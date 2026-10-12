/**
 * Settles due turn trail work. Nothing pushes a branch from trail work since
 * D59, so a pending row only waits for its turn's trail: it settles `no_op`,
 * and a push or discard completes it through the journal trigger instead.
 */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";

export async function settleTurnTrailWork(db: Database): Promise<void> {
  await db.execute(sql`
    UPDATE turn_trail_work SET state = 'no_op', updated_at = clock_timestamp()
    WHERE state = 'pending' AND next_attempt_at <= clock_timestamp()
  `);
}
