/**
 * Drizzle ThreadWorksRepository: SQL for the thread_works join table — thread-to-Work
 * membership and primary Work lookup. Primary upserts demote the previous primary first.
 */
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import type { ThreadWorksRepository } from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDb } from "./repositories.js";

export function createDrizzleThreadWorksRepository(db: DrizzleDb): ThreadWorksRepository {
  return {
    async addMembership(threadId: ThreadId, workId: WorkId, isPrimary: boolean): Promise<void> {
      const activeDb = currentDrizzleDb(db);
      const [thread] = await activeDb
        .select({ projectId: schema.threads.projectId })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId));
      if (!thread) {
        throw new Error("Thread membership requires an existing thread");
      }

      if (isPrimary) {
        await activeDb
          .update(schema.threadWorks)
          .set({ isPrimary: false })
          .where(
            and(eq(schema.threadWorks.threadId, threadId), eq(schema.threadWorks.isPrimary, true)),
          );
      }

      await activeDb
        .insert(schema.threadWorks)
        .values({
          threadId,
          workId,
          projectId: thread.projectId as ProjectId,
          isPrimary,
        })
        .onConflictDoUpdate({
          target: [schema.threadWorks.threadId, schema.threadWorks.workId],
          set: { projectId: thread.projectId, isPrimary },
        });
    },

    async findPrimary(threadId: ThreadId) {
      const [row] = await currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId })
        .from(schema.threadWorks)
        .where(
          and(eq(schema.threadWorks.threadId, threadId), eq(schema.threadWorks.isPrimary, true)),
        );
      return row ?? null;
    },

    async listByThread(threadId: ThreadId) {
      return currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId, isPrimary: schema.threadWorks.isPrimary })
        .from(schema.threadWorks)
        .where(eq(schema.threadWorks.threadId, threadId));
    },
  };
}
