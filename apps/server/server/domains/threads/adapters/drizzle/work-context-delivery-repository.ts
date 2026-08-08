/** Drizzle persistence for coalesced Work-context delivery obligations. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq, ne } from "drizzle-orm";
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
        .where(and(eq(schema.threads.id, threadId), ne(schema.threads.status, "archived")))
        .limit(1);
      const threadIds = thread ? [thread.id as ThreadId] : [];
      await enqueue(threadIds);
      return threadIds;
    },

    async enqueueProject(projectId: ProjectId) {
      const rows = await currentDrizzleDb(db)
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(and(eq(schema.threads.projectId, projectId), ne(schema.threads.status, "archived")));
      const threadIds = rows.map(({ id }) => id as ThreadId);
      await enqueue(threadIds);
      return threadIds;
    },

    async listPendingThreadIds() {
      const rows = await currentDrizzleDb(db)
        .select({ threadId: schema.workContextDeliveryObligations.threadId })
        .from(schema.workContextDeliveryObligations)
        .innerJoin(
          schema.threads,
          eq(schema.threads.id, schema.workContextDeliveryObligations.threadId),
        )
        .where(ne(schema.threads.status, "archived"));
      return rows.map(({ threadId }) => threadId as ThreadId);
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
