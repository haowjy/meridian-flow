/** Bounded indexed scan for turns that might have lost their process owner. */
import type { Database } from "@meridian/database";
import * as schema from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { OrphanTurnCandidate } from "../loop/orphaned-turn-recovery.js";

export async function listOrphanTurnCandidates(
  db: Database,
  limit: number,
): Promise<OrphanTurnCandidate[]> {
  return db
    .select({ id: schema.turns.id, threadId: schema.turns.threadId })
    .from(schema.turns)
    .where(
      and(
        eq(schema.turns.role, "assistant"),
        inArray(schema.turns.status, ["pending", "streaming", "waiting_interrupt"]),
      ),
    )
    .orderBy(asc(schema.turns.createdAt))
    .limit(limit);
}
