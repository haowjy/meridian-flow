/** Projection stub for isolated PostgreSQL adapters whose contract excludes cross-domain effects. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
import { inArray, sql } from "drizzle-orm";
import type { WorkProjectionMutation } from "../domains/projects/adapters/work-projection-mutation.js";
import { currentDrizzleDb } from "../shared/drizzle-transaction.js";

export function createTestWorkProjectionMutation(db: Database): WorkProjectionMutation {
  return {
    async publishWorks() {},
    async touchWorks(workIds, activityAt) {
      const unique = [...new Set(workIds)] as WorkId[];
      if (unique.length === 0) return;
      await currentDrizzleDb(db)
        .update(works)
        .set({
          entityRevision: sql`${works.entityRevision} + 1`,
          ...(activityAt ? { updatedAt: activityAt } : {}),
        })
        .where(inArray(works.id, unique));
    },
    async mutatePendingBranches(_branchIds, operation) {
      return operation();
    },
  };
}
