/**
 * Drizzle ThreadWorksRepository: SQL for the thread_works join table — thread-to-Work
 * membership and primary Work lookup. Primary upserts demote the previous primary first.
 */
import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import * as schema from "@meridian/database/schema";
import { and, eq } from "drizzle-orm";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import {
  requireLockedActiveWork,
  WorkLifecycleUnavailableError,
} from "../../../../shared/work-lifecycle-lock.js";
import {
  type ThreadWorksRepository,
  ThreadWorkUnavailableError,
} from "../../ports/repositories.js";
import { currentDrizzleDb, type DrizzleDatabase } from "./repositories.js";

export function createDrizzleThreadWorksRepository(db: DrizzleDatabase): ThreadWorksRepository {
  class MembershipSnapshotChanged extends Error {}

  async function mutateMembership<T>(
    threadId: ThreadId,
    targetWorkId: WorkId,
    changesPrimary: boolean,
    operation: (input: {
      activeDb: ReturnType<typeof currentDrizzleDb>;
      projectId: ProjectId;
      currentWorkId: WorkId | null;
    }) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      try {
        return await runInDrizzleTransaction(db, async () => {
          const activeDb = currentDrizzleDb(db);
          const [snapshot] = changesPrimary
            ? await activeDb
                .select({ workId: schema.threadWorks.workId })
                .from(schema.threadWorks)
                .where(
                  and(
                    eq(schema.threadWorks.threadId, threadId),
                    eq(schema.threadWorks.isPrimary, true),
                  ),
                )
                .limit(1)
            : [];
          const currentWorkId = (snapshot?.workId as WorkId | undefined) ?? null;

          // Work rows are the outer lifecycle lock. Sorting makes concurrent
          // primary changes acquire the old and target Works canonically.
          const workIds = [
            ...new Set([targetWorkId, ...(currentWorkId ? [currentWorkId] : [])]),
          ].sort();
          for (const workId of workIds) {
            try {
              await requireLockedActiveWork(db, workId);
            } catch (cause) {
              if (!(cause instanceof WorkLifecycleUnavailableError)) throw cause;
              throw new ThreadWorkUnavailableError();
            }
          }

          const [thread] = await activeDb
            .select({ projectId: schema.threads.projectId })
            .from(schema.threads)
            .where(eq(schema.threads.id, threadId))
            .for("update");
          if (!thread) throw new Error("Thread membership requires an existing thread");

          if (changesPrimary) {
            const [lockedCurrent] = await activeDb
              .select({ workId: schema.threadWorks.workId })
              .from(schema.threadWorks)
              .where(
                and(
                  eq(schema.threadWorks.threadId, threadId),
                  eq(schema.threadWorks.isPrimary, true),
                ),
              )
              .limit(1);
            if ((lockedCurrent?.workId ?? null) !== currentWorkId) {
              throw new MembershipSnapshotChanged();
            }
          }

          const [target] = await activeDb
            .select({ projectId: schema.works.projectId })
            .from(schema.works)
            .where(eq(schema.works.id, targetWorkId));
          if (!target || target.projectId !== thread.projectId) {
            throw new ThreadWorkUnavailableError();
          }
          return operation({
            activeDb,
            projectId: thread.projectId as ProjectId,
            currentWorkId,
          });
        });
      } catch (cause) {
        if (cause instanceof MembershipSnapshotChanged) continue;
        throw cause;
      }
    }
  }

  return {
    async addMembership(threadId: ThreadId, workId: WorkId, isPrimary: boolean): Promise<void> {
      return mutateMembership(threadId, workId, isPrimary, async ({ activeDb, projectId }) => {
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
      return mutateMembership(
        threadId,
        workId,
        true,
        async ({ activeDb, projectId, currentWorkId }) => {
          if (currentWorkId === workId) {
            return { previousWorkId: currentWorkId, changed: false };
          }

          await activeDb
            .delete(schema.threadWorks)
            .where(
              and(eq(schema.threadWorks.threadId, threadId), eq(schema.threadWorks.workId, workId)),
            );
          if (currentWorkId) {
            await activeDb
              .update(schema.threadWorks)
              .set({ workId, projectId })
              .where(
                and(
                  eq(schema.threadWorks.threadId, threadId),
                  eq(schema.threadWorks.isPrimary, true),
                ),
              );
          } else {
            await activeDb.insert(schema.threadWorks).values({
              threadId,
              workId,
              projectId,
              isPrimary: true,
            });
          }
          return { previousWorkId: currentWorkId, changed: true };
        },
      );
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

    async lockPrimary(threadId: ThreadId) {
      const activeDb = currentDrizzleDb(db);
      const [thread] = await activeDb
        .select({ id: schema.threads.id })
        .from(schema.threads)
        .where(eq(schema.threads.id, threadId))
        .for("update");
      if (!thread) return null;
      const [row] = await activeDb
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
