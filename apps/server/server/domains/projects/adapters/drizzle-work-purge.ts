/** Permanently removes expired Works, then best-effort removes their object-store blobs. */

import type { WorkId } from "@meridian/contracts/runtime";
import { DAY_MS, WORK_DELETE_RETENTION_DAYS, workPurgeAt } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  documentBranches,
  eventJournal,
  projectResults,
  threads,
  turns,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockWorkThreadTree } from "../../../shared/thread-work-lock.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import { type ObjectStorePort, objectStoreKeyFromStorageUrl } from "../../storage/index.js";

const WORK_PURGE_BATCH_LIMIT = 100;

export function createDrizzleWorkPurger(deps: {
  db: Database;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());

  async function deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of new Set(keys)) {
      try {
        const result = await deps.objectStore.delete(key);
        if (!result.ok && result.error.code !== "not_found") {
          emitEvent(deps.eventSink, {
            level: "warn",
            source: "projects.work-purge",
            name: "object_delete.failed",
            payload: { key, error: result.error },
          });
        }
      } catch (cause) {
        emitEvent(deps.eventSink, {
          level: "warn",
          source: "projects.work-purge",
          name: "object_delete.failed",
          payload: { key, error: cause instanceof Error ? cause.message : String(cause) },
        });
      }
    }
  }

  async function purge(
    workId: WorkId,
    currentTime: Date,
  ): Promise<{ purged: boolean; objectKeys: string[] }> {
    return runInDrizzleTransaction(deps.db, async () => {
      const lockedTree = await lockWorkThreadTree(deps.db, workId, { includeMarked: true });
      if (lockedTree.lifecycle !== "deleted" || lockedTree.changed) {
        return { purged: false, objectKeys: [] };
      }
      const activeDb = currentDrizzleDb(deps.db);
      const [work] = await activeDb
        .select({ id: works.id, deletedAt: works.deletedAt })
        .from(works)
        .where(eq(works.id, workId));
      if (!work?.deletedAt || workPurgeAt(work.deletedAt).getTime() > currentTime.getTime()) {
        return { purged: false, objectKeys: [] };
      }

      const [uploads, results] = await Promise.all([
        activeDb
          .select({ objectKey: uploadIntakes.objectKey })
          .from(uploadIntakes)
          .where(eq(uploadIntakes.workId, workId)),
        activeDb
          .select({ storageUrl: projectResults.storageUrl })
          .from(projectResults)
          .where(eq(projectResults.deletedByWorkId, workId)),
      ]);
      const objectKeys = [
        ...uploads.map(({ objectKey }) => objectKey),
        ...results.flatMap(({ storageUrl }) => {
          const key = objectStoreKeyFromStorageUrl(storageUrl);
          return key ? [key] : [];
        }),
      ];

      // Results and journal history restrict conversation deletion; branches restrict Work deletion.
      await activeDb.delete(projectResults).where(eq(projectResults.deletedByWorkId, workId));
      if (lockedTree.threadIds.length > 0) {
        await activeDb
          .delete(eventJournal)
          .where(inArray(eventJournal.threadId, lockedTree.threadIds));
        await activeDb.delete(turns).where(inArray(turns.threadId, lockedTree.threadIds));
        await activeDb.delete(threads).where(inArray(threads.id, lockedTree.threadIds));
      }
      await activeDb.delete(documentBranches).where(eq(documentBranches.workId, workId));
      const deleted = await activeDb
        .delete(works)
        .where(and(eq(works.id, workId), lte(works.deletedAt, currentTime)))
        .returning({ id: works.id });
      return { purged: deleted.length > 0, objectKeys };
    });
  }

  return {
    async sweep(): Promise<number> {
      const currentTime = now();
      const candidates = await currentDrizzleDb(deps.db)
        .select({ id: works.id })
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
        const result = await purge(candidate.id, currentTime);
        if (!result.purged) continue;
        count += 1;
        await deleteObjects(result.objectKeys);
      }
      return count;
    },
  };
}
