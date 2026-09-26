/**
 * Drizzle ThreadWorksRepository: SQL for the thread_works join table — thread-to-Work
 * membership and primary Work lookup. Primary upserts demote the previous primary first.
 */

import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import { lockThreadAndWorks } from "../../../../shared/thread-work-lock.js";
import { WorkLifecycleUnavailableError } from "../../../projects/domain/work-lifecycle.js";
import {
  ThreadMembershipUnavailableError,
  ThreadWorkProjectMismatchError,
  type ThreadWorksRepository,
} from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

export function createDrizzleThreadWorksRepository(db: DrizzleDatabase): ThreadWorksRepository {
  async function mutateMembership<T>(
    threadId: ThreadId,
    targetWorkId: WorkId,
    operation: (input: {
      activeDb: ReturnType<typeof currentDrizzleDb>;
      projectId: ProjectId;
      currentWorkId: WorkId | null;
    }) => Promise<T>,
  ): Promise<T> {
    return runInDrizzleTransaction(db, async () => {
      const activeDb = currentDrizzleDb(db);
      const thread = await lockThreadAndWorks(db, threadId, [targetWorkId]);
      if (!thread || thread.deletedAt) throw new ThreadMembershipUnavailableError(threadId);
      for (const [workId, state] of thread.workStates) {
        // Leaving an archived Work is cleanup, not acquisition of its content authority.
        if (state !== "active" && (workId === targetWorkId || state !== "archived")) {
          throw new WorkLifecycleUnavailableError(workId, state);
        }
      }
      const [target] = await activeDb
        .select({ projectId: schema.works.projectId })
        .from(schema.works)
        .where(eq(schema.works.id, targetWorkId));
      if (!target || target.projectId !== thread.projectId) {
        throw new ThreadWorkProjectMismatchError(targetWorkId);
      }
      return operation({
        activeDb,
        projectId: thread.projectId,
        currentWorkId: thread.primaryWorkId,
      });
    });
  }

  return {
    async addMembership(threadId: ThreadId, workId: WorkId, isPrimary: boolean): Promise<void> {
      return mutateMembership(threadId, workId, async ({ activeDb, projectId }) => {
        if (isPrimary) {
          await activeDb
            .update(schema.threadWorks)
            .set({ isPrimary: false })
            .where(
              and(
                eq(schema.threadWorks.threadId, threadId),
                eq(schema.threadWorks.isPrimary, true),
              ),
            );
        }

        await activeDb
          .insert(schema.threadWorks)
          .values({
            threadId,
            workId,
            projectId,
            isPrimary,
          })
          .onConflictDoUpdate({
            target: [schema.threadWorks.threadId, schema.threadWorks.workId],
            set: { projectId, isPrimary },
          });
      });
    },

    async rebindPrimary(threadId, workId) {
      return mutateMembership(threadId, workId, async ({ activeDb, projectId, currentWorkId }) => {
        if (currentWorkId === workId) {
          return { previousWorkId: currentWorkId, changed: false };
        }

        if (currentWorkId) {
          await activeDb
            .update(schema.threadWorks)
            .set({ isPrimary: false })
            .where(
              and(
                eq(schema.threadWorks.threadId, threadId),
                eq(schema.threadWorks.isPrimary, true),
              ),
            );
        }
        await activeDb
          .insert(schema.threadWorks)
          .values({ threadId, workId, projectId, isPrimary: true })
          .onConflictDoUpdate({
            target: [schema.threadWorks.threadId, schema.threadWorks.workId],
            set: { projectId, isPrimary: true },
          });
        return { previousWorkId: currentWorkId, changed: true };
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

    async rebindPrimaryForRestore(threadId, workId) {
      const activeDb = currentDrizzleDb(db);
      const [thread] = await activeDb
        .select({ projectId: schema.threads.projectId })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId));
      if (!thread) throw new ThreadMembershipUnavailableError(threadId);
      await activeDb
        .update(schema.threadWorks)
        .set({ isPrimary: false })
        .where(
          and(eq(schema.threadWorks.threadId, threadId), eq(schema.threadWorks.isPrimary, true)),
        );
      await activeDb
        .insert(schema.threadWorks)
        .values({ threadId, workId, projectId: thread.projectId, isPrimary: true })
        .onConflictDoUpdate({
          target: [schema.threadWorks.threadId, schema.threadWorks.workId],
          set: { projectId: thread.projectId, isPrimary: true },
        });
    },

    async listByThread(threadId: ThreadId) {
      return currentDrizzleDb(db)
        .select({ workId: schema.threadWorks.workId, isPrimary: schema.threadWorks.isPrimary })
        .from(schema.threadWorks)
        .where(eq(schema.threadWorks.threadId, threadId));
    },
  };
}
