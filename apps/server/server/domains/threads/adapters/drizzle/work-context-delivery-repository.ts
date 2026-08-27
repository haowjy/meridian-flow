/** Drizzle persistence for coalesced Work-context delivery obligations. */
import type { ProjectId, ThreadId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import type { WorkContextDeliveryRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

export function createDrizzleWorkContextDeliveryRepository(
  db: DrizzleDatabase,
): WorkContextDeliveryRepository {
  const deliverableThread = and(
    isNull(schema.threads.deletedAt),
    isNull(schema.projects.deletedAt),
    ne(schema.threads.status, "archived"),
  );

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
        .innerJoin(schema.projects, eq(schema.projects.id, schema.threads.projectId))
        .where(and(eq(schema.threads.id, threadId), deliverableThread))
        .limit(1);
      const threadIds = thread ? [thread.id as ThreadId] : [];
      await enqueue(threadIds);
      return threadIds;
    },

    async enqueueProject(projectId: ProjectId) {
      const rows = await currentDrizzleDb(db)
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .innerJoin(schema.projects, eq(schema.projects.id, schema.threads.projectId))
        .where(and(eq(schema.threads.projectId, projectId), deliverableThread));
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
        .innerJoin(schema.projects, eq(schema.projects.id, schema.threads.projectId))
        .where(deliverableThread);
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
        .innerJoin(
          schema.threads,
          eq(schema.threads.id, schema.workContextDeliveryObligations.threadId),
        )
        .innerJoin(schema.projects, eq(schema.projects.id, schema.threads.projectId))
        .where(and(eq(schema.workContextDeliveryObligations.threadId, threadId), deliverableThread))
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
