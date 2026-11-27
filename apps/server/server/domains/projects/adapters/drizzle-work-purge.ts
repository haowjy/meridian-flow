import type { DocumentId, DraftId } from "@meridian/contracts";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  drafts,
  eventJournal,
  projectResults,
  promptBakes,
  threads,
  threadWorks,
  turns,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { LIVE, type TrashEntry, type TreeWriter } from "@meridian/project-tree";
import { and, asc, eq, gt, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { workDefaultDraftSql } from "../../../shared/draft-owner.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockWorkThreadTree } from "../../../shared/thread-work-lock.js";
import { type DocumentContentEnd, releaseDocumentContent } from "../../context/index.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import {
  chatMediaPrefix,
  createObjectRelease,
  incomingObjectKey,
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
} from "../../storage/index.js";
import type { WorkDraftDisposal } from "../ports/work-draft-disposal.js";
import type { WorkProjectionMutation } from "./work-projection-mutation.js";

const WORK_PURGE_BATCH_LIMIT = 100;

function purgeSources(writer: TreeWriter, sources: ReadonlySet<string>): DocumentId[] {
  const inSources = () =>
    [...writer.view(LIVE).nodes.values()].filter((node) => sources.has(node.source));
  const standing = inSources().filter((node) => !node.trashed && !node.purged);
  const standingIds = new Set(standing.map((node) => node.id));
  writer.deleteAll(
    LIVE,
    "system",
    standing.filter((node) => !standingIds.has(node.parent)).map((node) => node.id),
  );
  const view = writer.view(LIVE);
  const takenBy = new Map<string, { entry: TrashEntry; nodes: Set<string> }>();
  for (const entry of view.trash) {
    if (!sources.has(view.nodes.get(entry.node)?.source ?? "")) continue;
    const taken = takenBy.get(entry.node) ?? { entry, nodes: new Set() };
    for (const id of [entry.node, ...entry.cascade]) taken.nodes.add(id);
    takenBy.set(entry.node, taken);
  }
  for (const { entry, nodes } of takenBy.values()) writer.purge("system", entry, [...nodes]);
  return inSources()
    .filter((node) => node.kind !== "folder")
    .map((node) => node.id as DocumentId);
}

export function createDrizzleWorkPurger(deps: {
  db: Database;
  objectStore: Pick<ObjectStorePort, "delete" | "list">;
  eventSink: EventSink;
  drafts: WorkDraftDisposal;
  tree: Pick<TreeListStore, "submit">;
  works: Pick<WorkProjectionMutation, "lifecycleChanged">;
  collab: {
    endRooms: DocumentContentEnd["endRooms"];
    evidence: DocumentContentEnd["evidence"] & {
      forgetThreads(threadIds: readonly ThreadId[]): Promise<void>;
    };
  };
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

  async function chatMediaKeys(threadIds: readonly string[]): Promise<string[]> {
    const keys: string[] = [];
    for (const threadId of threadIds) {
      let cursor: string | undefined;
      do {
        const page = await deps.objectStore.list(chatMediaPrefix(threadId), { cursor });
        if (!page.ok) {
          emitEvent(deps.eventSink, {
            level: "warn",
            source: "projects.work-purge",
            name: "object_list.failed",
            payload: { threadId, error: page.error },
          });
          break;
        }
        keys.push(...page.value.keys.map((entry) => entry.key));
        cursor = page.value.cursor;
      } while (cursor);
    }
    return keys;
  }

  async function purge(
    workId: WorkId,
    cutoff: Date,
  ): Promise<{ purged: boolean; objectKeys: string[]; threadIds: readonly string[] }> {
    return deps.drafts.withDisposal(workId, (disposeDrafts) =>
      purgeLocked(workId, cutoff, disposeDrafts),
    );
  }

  async function purgeLocked(
    workId: WorkId,
    cutoff: Date,
    disposeDrafts: (
      lineageRootIds: readonly string[],
    ) => Promise<{ releasedObjects: readonly string[]; draftIds: readonly DraftId[] }>,
  ): Promise<{ purged: boolean; objectKeys: string[]; threadIds: readonly string[] }> {
    return runInDrizzleTransaction(deps.db, async () => {
      const lockedTree = await lockWorkThreadTree(deps.db, workId, { includeMarked: true });
      if (lockedTree.lifecycle !== "deleted" || lockedTree.changed) {
        return { purged: false, objectKeys: [], threadIds: [] };
      }
      const activeDb = currentDrizzleDb(deps.db);
      const [work] = await activeDb
        .select({
          id: works.id,
          projectId: works.projectId,
          draftId: workDefaultDraftSql(),
          deletedAt: works.deletedAt,
        })
        .from(works)
        .where(eq(works.id, workId));
      if (!work?.deletedAt || work.deletedAt.getTime() > cutoff.getTime()) {
        return { purged: false, objectKeys: [], threadIds: [] };
      }

      if (lockedTree.threadIds.length > 0) {
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
          return { purged: false, objectKeys: [], threadIds: [] };
        }
      }

      const [uploads, results, sourceRows] = await Promise.all([
        lockedTree.threadIds.length
          ? activeDb
              .select({
                projectId: uploadIntakes.projectId,
                documentId: uploadIntakes.documentId,
                objectKey: uploadIntakes.objectKey,
              })
              .from(uploadIntakes)
              .where(inArray(uploadIntakes.ownerThreadId, lockedTree.threadIds))
          : Promise.resolve([] as { projectId: string; documentId: string; objectKey: string }[]),
        activeDb
          .select({ storageUrl: projectResults.storageUrl })
          .from(projectResults)
          .where(eq(projectResults.deletedByWorkId, workId)),
        activeDb
          .select({ id: contextSources.id })
          .from(contextSources)
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
      const purgedRoots = lockedTree.threadIds.length
        ? (
            await activeDb
              .select({ id: threads.id })
              .from(threads)
              .where(
                and(
                  inArray(threads.id, lockedTree.threadIds),
                  eq(threads.rootThreadId, threads.id),
                ),
              )
          ).map((row) => row.id)
        : [];
      const disposed = await disposeDrafts(purgedRoots);
      const sources = new Set<string>(sourceRows.map(({ id }) => id));
      const released =
        sources.size === 0
          ? { storageUrls: [] as string[] }
          : await deps.tree
              .submit({
                lists: [{ kind: "project", projectId: work.projectId }],
                make: ([{ writer }]) => purgeSources(writer, sources),
              })
              .then(({ result }) => releaseDocumentContent(deps.db, deps.collab, result));
      const objectKeys = [
        ...uploads.flatMap((upload) => [
          upload.objectKey,
          incomingObjectKey(upload.projectId, upload.documentId),
        ]),
        ...[...results.map(({ storageUrl }) => storageUrl), ...released.storageUrls].flatMap(
          (storageUrl) => {
            const key = storageUrl ? objectStoreKeyFromStorageUrl(storageUrl) : null;
            return key ? [key] : [];
          },
        ),
        ...disposed.releasedObjects.flatMap((storageUrl) => {
          const key = objectStoreKeyFromStorageUrl(storageUrl);
          return key ? [key] : [];
        }),
      ];

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
        await activeDb.execute(sql`SET CONSTRAINTS threads_origin_turn_id_turns_id_fk DEFERRED`);
        await activeDb.delete(turns).where(inArray(turns.threadId, lockedTree.threadIds));
        await activeDb.delete(threads).where(inArray(threads.id, lockedTree.threadIds));
        await deps.collab.evidence.forgetThreads(lockedTree.threadIds);
      }
      await activeDb
        .delete(threadWorks)
        .where(and(eq(threadWorks.workId, workId), eq(threadWorks.isPrimary, false)));
      const deleted = await activeDb
        .delete(works)
        .where(and(eq(works.id, workId), lte(works.deletedAt, cutoff)))
        .returning({ id: works.id, entityRevision: works.entityRevision });
      if (deleted[0]) {
        // Move a purged Work's revision to No Work so the project snapshot sum never falls
        await activeDb
          .update(works)
          .set({
            entityRevision: sql`${works.entityRevision} + ${String(deleted[0].entityRevision)}::bigint + 1`,
          })
          .where(and(eq(works.projectId, work.projectId), eq(works.isNoWork, true)));
        deps.works.lifecycleChanged({
          id: workId,
          projectId: work.projectId,
          draftId: work.draftId,
        });
      }
      if (disposed.draftIds.length > 0)
        await activeDb.delete(drafts).where(inArray(drafts.id, [...disposed.draftIds]));
      return { purged: deleted.length > 0, objectKeys, threadIds: lockedTree.threadIds };
    });
  }

  return {
    async sweep(): Promise<number> {
      const currentTime = now();
      const cutoff = deletionPurgeCutoff(currentTime);
      let count = 0;
      let after: { id: WorkId; deletedAt: Date } | undefined;
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
          let result: Awaited<ReturnType<typeof purge>>;
          try {
            result = await purge(candidate.id, cutoff);
          } catch (error) {
            emitEvent(deps.eventSink, {
              level: "error",
              source: "projects.work-purge",
              name: "purge.failed",
              payload: { workId: candidate.id, error },
            });
            continue;
          }
          if (!result.purged) continue;
          count += 1;
          await objects.keys([...result.objectKeys, ...(await chatMediaKeys(result.threadIds))]);
        }
      }
      return count;
    },
  };
}
