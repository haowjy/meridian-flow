/** Permanently removes expired Works, their owned rows, and object-store blobs. */

import type { ThreadId } from "@meridian/contracts/runtime";
import { WORK_DELETE_RETENTION_DAYS, workPurgeAt } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  documentBranches,
  projectResults,
  threads,
  threadWorks,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import { lockWorkLifecycle } from "../../../shared/work-lifecycle-lock.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WORK_PURGE_BATCH_LIMIT = 100;

function objectStoreError(key: string, error: { code: string; message: string }): Error {
  return new Error(`Failed to delete Work object ${key}: ${error.code}: ${error.message}`);
}

export function createDrizzleWorkPurger(deps: {
  db: Database;
  objectStore: ObjectStorePort;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of new Set(keys)) {
      const result = await deps.objectStore.delete(key);
      if (!result.ok && result.error.code !== "not_found") {
        throw objectStoreError(key, result.error);
      }
    }
  }

  async function findWorkThreadIds(workId: string): Promise<string[]> {
    const activeDb = currentDrizzleDb(deps.db);
    const roots = await activeDb
      .select({ id: threads.id })
      .from(threadWorks)
      .innerJoin(threads, eq(threadWorks.threadId, threads.id))
      .where(and(eq(threadWorks.workId, workId as never), eq(threadWorks.isPrimary, true)));
    const threadIds = new Set(roots.map(({ id }) => id));
    let frontier = [...threadIds];
    while (frontier.length > 0) {
      const children = await activeDb
        .select({ id: threads.id })
        .from(threads)
        .where(inArray(threads.parentThreadId, frontier));
      frontier = [];
      for (const { id } of children) {
        if (threadIds.has(id)) continue;
        threadIds.add(id);
        frontier.push(id);
      }
    }
    const cascadeMarked = await activeDb
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.deletedByWorkId, workId as never));
    for (const { id } of cascadeMarked) threadIds.add(id);
    return [...threadIds];
  }

  async function purge(workId: string, currentTime: Date): Promise<boolean> {
    const activeDb = currentDrizzleDb(deps.db);
    const uploads = await activeDb
      .select({ objectKey: uploadIntakes.objectKey })
      .from(uploadIntakes)
      .where(eq(uploadIntakes.workId, workId as never));
    const results = await activeDb
      .select({ storageUrl: projectResults.storageUrl })
      .from(projectResults)
      .where(eq(projectResults.deletedByWorkId, workId as never));
    await deleteObjects([
      ...uploads.map(({ objectKey }) => objectKey),
      ...results.flatMap(({ storageUrl }) => {
        const key = objectStoreKeyFromStorageUrl(storageUrl);
        return key ? [key] : [];
      }),
    ]);

    return runInDrizzleTransaction(deps.db, async () => {
      const initialThreadIds = await findWorkThreadIds(workId);
      for (const threadId of initialThreadIds.sort()) {
        await lockThreadForMutation(deps.db, threadId as ThreadId);
      }
      const lifecycle = await lockWorkLifecycle(deps.db, workId);
      if (lifecycle !== "deleted") return false;
      const [work] = await currentDrizzleDb(deps.db)
        .select({ id: works.id, deletedAt: works.deletedAt })
        .from(works)
        .where(eq(works.id, workId as never));
      if (!work?.deletedAt || workPurgeAt(work.deletedAt).getTime() > currentTime.getTime()) {
        return false;
      }

      const threadIds = await findWorkThreadIds(workId);
      if (threadIds.some((threadId) => !initialThreadIds.includes(threadId))) return false;
      await currentDrizzleDb(deps.db)
        .delete(projectResults)
        .where(eq(projectResults.deletedByWorkId, workId as never));
      if (threadIds.length > 0) {
        await currentDrizzleDb(deps.db).delete(threads).where(inArray(threads.id, threadIds));
      }
      await currentDrizzleDb(deps.db)
        .delete(threadWorks)
        .where(eq(threadWorks.workId, workId as never));
      await currentDrizzleDb(deps.db)
        .delete(documentBranches)
        .where(eq(documentBranches.workId, workId as never));
      const deleted = await currentDrizzleDb(deps.db)
        .delete(works)
        .where(and(eq(works.id, workId as never), lte(works.deletedAt, currentTime)))
        .returning({ id: works.id });
      return deleted.length > 0;
    });
  }

  return {
    async sweep(): Promise<number> {
      const currentTime = now();
      const candidates = await currentDrizzleDb(deps.db)
        .select({ id: works.id, deletedAt: works.deletedAt })
        .from(works)
        .where(
          and(
            isNotNull(works.deletedAt),
            lte(
              works.deletedAt,
              new Date(currentTime.getTime() - WORK_DELETE_RETENTION_DAYS * DAY_MS),
            ),
          ),
        )
        .orderBy(asc(works.deletedAt), asc(works.id))
        .limit(WORK_PURGE_BATCH_LIMIT);
      let count = 0;
      for (const candidate of candidates) {
        if (
          !candidate.deletedAt ||
          workPurgeAt(candidate.deletedAt).getTime() > currentTime.getTime()
        )
          continue;
        if (await purge(candidate.id, currentTime)) count += 1;
      }
      return count;
    },
  };
}
