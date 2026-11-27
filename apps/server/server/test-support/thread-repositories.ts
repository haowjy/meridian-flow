import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { works } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { createDrizzleLineageScratchLifecycle } from "../domains/context/index.js";
import type { WorkProjectionMutation } from "../domains/projects/index.js";
import { createDrizzleRepositories } from "../domains/threads/adapters/drizzle/repositories.js";
import type { InternalThreadRepositories } from "../domains/threads/ports/repositories.js";
import { currentDrizzleDb } from "../shared/drizzle-transaction.js";

export function quietWorkActivity(
  db: Database,
): Pick<WorkProjectionMutation, "touchWorks" | "recountAfterCommit"> {
  return {
    async touchWorks(workIds: readonly WorkId[], activityAt: Date) {
      await currentDrizzleDb(db)
        .update(works)
        .set({ updatedAt: activityAt })
        .where(inArray(works.id, [...workIds]));
    },
    recountAfterCommit() {},
  };
}

export function createDrizzleRepositoriesForTest(db: Database): InternalThreadRepositories {
  return createDrizzleRepositories(
    db,
    quietWorkActivity(db),
    createDrizzleLineageScratchLifecycle(db),
  );
}
