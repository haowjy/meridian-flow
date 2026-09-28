/** Drizzle persistence for thread-local image inclusion decisions. */
import * as schema from "@meridian/database/schema";
import { asc, eq } from "drizzle-orm";
import type { ThreadImageInclusionRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

export function createDrizzleThreadImageInclusionRepository(
  db: DrizzleDb,
): ThreadImageInclusionRepository {
  return {
    async findByThread(threadId, revertedCompactions) {
      const rows = await currentDrizzleDb(db)
        .select({
          threadId: schema.threadImageInclusions.threadId,
          blockId: schema.threadImageInclusions.blockId,
          decisionTurnId: schema.threadImageInclusions.decisionTurnId,
          included: schema.threadImageInclusions.included,
          position: schema.turns.position,
        })
        .from(schema.threadImageInclusions)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.threadImageInclusions.decisionTurnId))
        .where(eq(schema.threadImageInclusions.threadId, threadId))
        .orderBy(asc(schema.turns.position));
      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows)
        if (!revertedCompactions?.has(row.decisionTurnId)) latest.set(row.blockId, row);
      return [...latest.values()].map(({ position: _position, ...decision }) => decision);
    },
    async listByThread(threadId) {
      return currentDrizzleDb(db)
        .select({
          threadId: schema.threadImageInclusions.threadId,
          blockId: schema.threadImageInclusions.blockId,
          decisionTurnId: schema.threadImageInclusions.decisionTurnId,
          included: schema.threadImageInclusions.included,
        })
        .from(schema.threadImageInclusions)
        .where(eq(schema.threadImageInclusions.threadId, threadId))
        .orderBy(asc(schema.threadImageInclusions.decidedAt));
    },
    async set(input) {
      await currentDrizzleDb(db)
        .insert(schema.threadImageInclusions)
        .values(input)
        .onConflictDoNothing({
          target: [
            schema.threadImageInclusions.threadId,
            schema.threadImageInclusions.blockId,
            schema.threadImageInclusions.decisionTurnId,
          ],
        });
    },
  };
}
