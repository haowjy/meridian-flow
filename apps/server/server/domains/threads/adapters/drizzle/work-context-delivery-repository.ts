/** Drizzle persistence for coalesced Work-context delivery obligations. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq, isNotNull, ne } from "drizzle-orm";
import type { WorkContextDeliveryRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

export function createDrizzleWorkContextDeliveryRepository(
  db: DrizzleDatabase,
): WorkContextDeliveryRepository {
  async function enqueue(threadIds: ThreadId[]): Promise<void> {
    if (threadIds.length === 0) return;
    const requestedAt = new Date();
    await currentDrizzleDb(db)
      .insert(schema.workContextDeliveryObligations)
      .values(threadIds.map((threadId) => ({ threadId, requestedAt })))
      .onConflictDoUpdate({
        target: schema.workContextDeliveryObligations.threadId,
        set: { requestedAt },
      });
  }

  return {
    async enqueueThread(threadId) {
      const [thread] = await currentDrizzleDb(db)
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(
          and(
            eq(schema.threads.id, threadId),
            ne(schema.threads.status, "archived"),
            // A thread without a frozen prompt reads current Work state at its first bake.
            isNotNull(schema.threads.bakedSkillSlugs),
          ),
        )
        .limit(1);
      if (thread) await enqueue([thread.id as ThreadId]);
    },

    async enqueueProject(projectId: ProjectId) {
      const rows = await currentDrizzleDb(db)
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(
          and(
            eq(schema.threads.projectId, projectId),
            ne(schema.threads.status, "archived"),
            isNotNull(schema.threads.bakedSkillSlugs),
          ),
        );
      await enqueue(rows.map(({ id }) => id as ThreadId));
    },

    async isPending(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ threadId: schema.workContextDeliveryObligations.threadId })
        .from(schema.workContextDeliveryObligations)
        .where(eq(schema.workContextDeliveryObligations.threadId, threadId))
        .limit(1);
      return !!row;
    },

    async lockPending(threadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ threadId: schema.workContextDeliveryObligations.threadId })
        .from(schema.workContextDeliveryObligations)
        .where(eq(schema.workContextDeliveryObligations.threadId, threadId))
        .for("update")
        .limit(1);
      return !!row;
    },

    async acknowledge(threadId) {
      await currentDrizzleDb(db)
        .delete(schema.workContextDeliveryObligations)
        .where(eq(schema.workContextDeliveryObligations.threadId, threadId));
    },
  };
}
