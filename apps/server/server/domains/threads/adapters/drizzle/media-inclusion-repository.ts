/** Drizzle persistence for thread-local image inclusion decisions. */
import * as schema from "@meridian/database/schema";
import { asc, eq } from "drizzle-orm";
import type { ThreadMediaInclusionRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

export function createDrizzleThreadMediaInclusionRepository(
  db: DrizzleDb,
): ThreadMediaInclusionRepository {
  return {
    async findByThread(threadId) {
      const rows = await currentDrizzleDb(db)
        .select({
          threadId: schema.threadMediaInclusions.threadId,
          blockId: schema.threadMediaInclusions.blockId,
          partIndex: schema.threadMediaInclusions.partIndex,
          decisionTurnId: schema.threadMediaInclusions.decisionTurnId,
          included: schema.threadMediaInclusions.included,
          position: schema.turns.position,
        })
        .from(schema.threadMediaInclusions)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.threadMediaInclusions.decisionTurnId))
        .where(eq(schema.threadMediaInclusions.threadId, threadId))
        .orderBy(asc(schema.turns.position));
      const latest = new Map<string, (typeof rows)[number]>();
      for (const row of rows) latest.set(`${row.blockId}\0${row.partIndex}`, row);
      return [...latest.values()].map(({ position: _position, ...decision }) => decision);
    },
    async listByThread(threadId) {
      return currentDrizzleDb(db)
        .select({
          threadId: schema.threadMediaInclusions.threadId,
          blockId: schema.threadMediaInclusions.blockId,
          partIndex: schema.threadMediaInclusions.partIndex,
          decisionTurnId: schema.threadMediaInclusions.decisionTurnId,
          included: schema.threadMediaInclusions.included,
        })
        .from(schema.threadMediaInclusions)
        .where(eq(schema.threadMediaInclusions.threadId, threadId))
        .orderBy(asc(schema.threadMediaInclusions.decidedAt));
    },
    async set(input) {
      await currentDrizzleDb(db)
        .insert(schema.threadMediaInclusions)
        .values(input)
        .onConflictDoNothing({
          target: [
            schema.threadMediaInclusions.threadId,
            schema.threadMediaInclusions.blockId,
            schema.threadMediaInclusions.partIndex,
            schema.threadMediaInclusions.decisionTurnId,
          ],
        });
    },
  };
}
