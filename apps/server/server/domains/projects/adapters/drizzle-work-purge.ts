/**
 * Permanently removes expired Works, then best-effort removes their object-store blobs.
 * A purged Work's branches are disposed of first through collab's locked Discard kernel
 * (contract §2.6, F10): their drafts leased before the transaction, then, after the
 * deleted/cutoff proof, every hidden document they created tombstoned and released.
 */

import type { WorkId } from "@meridian/contracts/runtime";
import { workPurgeCutoff } from "@meridian/contracts/works";
import type { Database } from "@meridian/database";
import {
  branches,
  contextSources,
  documents,
  eventJournal,
  projectResults,
  promptBakes,
  threads,
  turns,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, gt, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockWorkThreadTree } from "../../../shared/thread-work-lock.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import {
  createObjectRelease,
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
} from "../../storage/index.js";
import type { WorkBranchDisposal } from "../ports/work-branch-disposal.js";

const WORK_PURGE_BATCH_LIMIT = 100;

export function createDrizzleWorkPurger(deps: {
  db: Database;
  objectStore: ObjectStorePort;
  eventSink: EventSink;
  branches: WorkBranchDisposal;
  now?: () => Date;
}) {
  const now = deps.now ?? (() => new Date());
  const objects = createObjectRelease({
    objectStore: deps.objectStore,
    onFailure(key, error) {
      emitEvent(deps.eventSink, {
        level: "warn",
        source: "projects.work-purge",
        name: "object_delete.failed",
        payload: { key, error },
      });
    },
  });

  async function purge(
    workId: WorkId,
    cutoff: Date,
  ): Promise<{ purged: boolean; objectKeys: string[] }> {
    return deps.branches.withDisposal(workId, (disposeDrafts) =>
      purgeLocked(workId, cutoff, disposeDrafts),
    );
  }

  async function purgeLocked(
    workId: WorkId,
    cutoff: Date,
    disposeDrafts: () => Promise<{ releasedObjects: readonly string[] }>,
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
      if (!work?.deletedAt || work.deletedAt.getTime() > cutoff.getTime()) {
        return { purged: false, objectKeys: [] };
      }

      if (lockedTree.threadIds.length > 0) {
        // A rebound fork/handoff still owns its source identity and may share its bake.
        // Never let the root FK cascade delete another Work's conversation.
        const [dependent] = await activeDb
          .select({ id: threads.id })
          .from(threads)
          .where(
            and(
              notInArray(threads.id, lockedTree.threadIds),
              or(
                inArray(threads.rootThreadId, lockedTree.threadIds),
                inArray(
                  threads.originTurnId,
                  activeDb
                    .select({ id: turns.id })
                    .from(turns)
                    .where(inArray(turns.threadId, lockedTree.threadIds)),
                ),
                inArray(
                  threads.initialPromptBakeId,
                  activeDb
                    .select({ id: promptBakes.id })
                    .from(promptBakes)
                    .where(inArray(promptBakes.ownerThreadId, lockedTree.threadIds)),
                ),
              ),
            ),
          )
          .limit(1);
        if (dependent) {
          emitEvent(deps.eventSink, {
            level: "info",
            source: "projects.work-purge",
            name: "purge.retained",
            payload: { workId, dependentThreadId: dependent.id },
          });
          return { purged: false, objectKeys: [] };
        }
      }

      const [uploads, results, binaries] = await Promise.all([
        // The Work owns no uploads; its threads' chats do.
        lockedTree.threadIds.length
          ? activeDb
              .select({ objectKey: uploadIntakes.objectKey })
              .from(uploadIntakes)
              .where(inArray(uploadIntakes.ownerThreadId, lockedTree.threadIds))
          : Promise.resolve([] as { objectKey: string }[]),
        activeDb
          .select({ storageUrl: projectResults.storageUrl })
          .from(projectResults)
          .where(eq(projectResults.deletedByWorkId, workId)),
        activeDb
          .select({ storageUrl: documents.storageUrl })
          .from(documents)
          .innerJoin(contextSources, eq(contextSources.id, documents.contextSourceId))
          .where(
            or(
              eq(contextSources.workId, workId),
              lockedTree.threadIds.length
                ? inArray(contextSources.rootThreadId, lockedTree.threadIds)
                : sql`false`,
              lockedTree.threadIds.length
                ? inArray(contextSources.chatThreadId, lockedTree.threadIds)
                : sql`false`,
            ),
          ),
      ]);
      // F10: the Work's branches end through the Discard kernel, after this proof and before
      // their rows go, so nothing they created stays live and their storage is released.
      const disposed = await disposeDrafts();
      const objectKeys = [
        ...uploads.map(({ objectKey }) => objectKey),
        ...[...results, ...binaries].flatMap(({ storageUrl }) => {
          const key = storageUrl ? objectStoreKeyFromStorageUrl(storageUrl) : null;
          return key ? [key] : [];
        }),
        ...disposed.releasedObjects.flatMap((storageUrl) => {
          const key = objectStoreKeyFromStorageUrl(storageUrl);
          return key ? [key] : [];
        }),
      ];

      // Results and journal history restrict conversation deletion.
      await activeDb.delete(projectResults).where(eq(projectResults.deletedByWorkId, workId));
      if (lockedTree.threadIds.length > 0) {
        await activeDb
          .delete(contextSources)
          .where(
            or(
              inArray(contextSources.rootThreadId, lockedTree.threadIds),
              inArray(contextSources.chatThreadId, lockedTree.threadIds),
            ),
          );
        await activeDb
          .delete(eventJournal)
          .where(inArray(eventJournal.threadId, lockedTree.threadIds));
        // Turns restrict thread deletion; derived threads retain non-nulling source-turn refs.
        // Defer that one cycle until both sides are gone, without weakening provenance elsewhere.
        await activeDb.execute(sql`SET CONSTRAINTS threads_origin_turn_id_turns_id_fk DEFERRED`);
        await activeDb.delete(turns).where(inArray(turns.threadId, lockedTree.threadIds));
        await activeDb.delete(threads).where(inArray(threads.id, lockedTree.threadIds));
      }
      // The disposed branches' rows go with the Work; their closed drafts cascade.
      await activeDb.delete(branches).where(eq(branches.originWorkId, workId));
      const deleted = await activeDb
        .delete(works)
        .where(and(eq(works.id, workId), lte(works.deletedAt, cutoff)))
        .returning({ id: works.id });
      return { purged: deleted.length > 0, objectKeys };
    });
  }

  return {
    async sweep(): Promise<number> {
      const currentTime = now();
      const cutoff = workPurgeCutoff(currentTime);
      let count = 0;
      let after: { id: WorkId; deletedAt: Date } | undefined;
      // Retained sources must not pin the oldest page and starve later eligible Works.
      while (count < WORK_PURGE_BATCH_LIMIT) {
        const candidates = await currentDrizzleDb(deps.db)
          .select({
            id: works.id,
            deletedAt: sql<Date>`${works.deletedAt}`.mapWith(works.deletedAt),
          })
          .from(works)
          .where(
            and(
              isNotNull(works.deletedAt),
              lte(works.deletedAt, cutoff),
              after
                ? or(
                    gt(works.deletedAt, after.deletedAt),
                    and(eq(works.deletedAt, after.deletedAt), gt(works.id, after.id)),
                  )
                : undefined,
            ),
          )
          .orderBy(asc(works.deletedAt), asc(works.id))
          .limit(WORK_PURGE_BATCH_LIMIT - count);
        after = candidates.at(-1);
        if (!after) break;
        for (const candidate of candidates) {
          const result = await purge(candidate.id, cutoff);
          if (!result.purged) continue;
          count += 1;
          await objects.keys(result.objectKeys);
        }
      }
      return count;
    },
  };
}
