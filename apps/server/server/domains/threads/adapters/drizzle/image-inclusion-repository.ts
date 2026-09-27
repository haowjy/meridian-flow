/** Drizzle persistence for thread-local image inclusion decisions. */
import * as schema from "@meridian/database/schema";
import { eq } from "drizzle-orm";
import type { ThreadImageInclusionRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

export function createDrizzleThreadImageInclusionRepository(
  db: DrizzleDb,
): ThreadImageInclusionRepository {
  return {
    async findByThread(threadId) {
      const rows = await currentDrizzleDb(db)
        .select({
          threadId: schema.threadImageInclusions.threadId,
          blockId: schema.threadImageInclusions.blockId,
          decisionTurnId: schema.threadImageInclusions.decisionTurnId,
          included: schema.threadImageInclusions.included,
        })
        .from(schema.threadImageInclusions)
        .where(eq(schema.threadImageInclusions.threadId, threadId));
      return rows;
    },
    async set(input) {
      await currentDrizzleDb(db)
        .insert(schema.threadImageInclusions)
        .values(input)
        .onConflictDoUpdate({
          target: [schema.threadImageInclusions.threadId, schema.threadImageInclusions.blockId],
          set: { included: input.included, decisionTurnId: input.decisionTurnId },
        });
    },
  };
}
