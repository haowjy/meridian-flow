/**
 * Permanently removes expired Works, then best-effort removes their object-store blobs.
 * A purged Work's branches end first through collab's Discard (contract §2.6, F10): their drafts
 * leased before the transaction, then, after the deleted/cutoff proof, one settlement discards
 * every pending record of the Work. The documents it drafted are then in no view, and retention
 * releases them on its own window. The Work's sources go with it: first a `purge` record in the
 * project's list for every node in them (the browsers read "gone for good" from that record), and
 * the content release Trash retention uses; then their source rows, which take any node rows left.
 */

import type { DocumentId } from "@meridian/contracts";
import { deletionPurgeCutoff } from "@meridian/contracts/retention";
import type { ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branches,
  contextSources,
  eventJournal,
  projectResults,
  promptBakes,
  threads,
  threadWorks,
  turns,
  uploadIntakes,
  works,
} from "@meridian/database/schema";
import { LIVE, type TreeWriter } from "@meridian/project-tree";
import { and, asc, eq, gt, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { lockWorkThreadTree } from "../../../shared/thread-work-lock.js";
import { releaseDocumentContent } from "../../context/index.js";
import type { TreeListStore } from "../../context/ports/tree-list-store.js";
import { type EventSink, emitEvent } from "../../observability/index.js";
import {
  chatMediaPrefix,
  createObjectRelease,
  incomingObjectKey,
  type ObjectStorePort,
  objectStoreKeyFromStorageUrl,
} from "../../storage/index.js";
import type { WorkBranchDisposal } from "../ports/work-branch-disposal.js";
import type { WorkProjectionMutation } from "./work-projection-mutation.js";

const WORK_PURGE_BATCH_LIMIT = 100;

/**
 * Ends every node in the sources for good, in one submission (a folder purged while a child's row
 * stands fails the deferred foreign key). What stands is deleted first, since a `purge` names a
 * delete in force. Returns the documents to release.
 */
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
  for (const entry of view.trash)
    if (sources.has(view.nodes.get(entry.node)?.source ?? ""))
      writer.purge("system", entry, [entry.node, ...entry.cascade]);
  return inSources()
    .filter((node) => node.kind !== "folder")
    .map((node) => node.id as DocumentId);
}

export function createDrizzleWorkPurger(deps: {
  db: Database;
  objectStore: Pick<ObjectStorePort, "delete" | "list">;
  eventSink: EventSink;
  branches: WorkBranchDisposal;
  /** The project's list, where the Work's sources' nodes end. */
  tree: Pick<TreeListStore, "submit">;
  /** A purged Work leaves the project's Works list, which is woken for it. */
  works: Pick<WorkProjectionMutation, "lifecycleChanged">;
  /** What the model was shown of documents, kept by the document side. */
  evidence: { forgetThreads(threadIds: readonly ThreadId[]): Promise<void> };
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

  /** The pictures the writers of these threads sent: the chats' own copies, found by prefix. */
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
    return deps.branches.withDisposal(workId, (disposeDrafts) =>
      purgeLocked(workId, cutoff, disposeDrafts),
    );
  }

  async function purgeLocked(
    workId: WorkId,
    cutoff: Date,
    disposeDrafts: (
      lineageRootIds: readonly string[],
    ) => Promise<{ releasedObjects: readonly string[] }>,
  ): Promise<{ purged: boolean; objectKeys: string[]; threadIds: readonly string[] }> {
    return runInDrizzleTransaction(deps.db, async () => {
      const lockedTree = await lockWorkThreadTree(deps.db, workId, { includeMarked: true });
      if (lockedTree.lifecycle !== "deleted" || lockedTree.changed) {
        return { purged: false, objectKeys: [], threadIds: [] };
      }
      const activeDb = currentDrizzleDb(deps.db);
      const [work] = await activeDb
        .select({ id: works.id, projectId: works.projectId, deletedAt: works.deletedAt })
        .from(works)
        .where(eq(works.id, workId));
      if (!work?.deletedAt || work.deletedAt.getTime() > cutoff.getTime()) {
        return { purged: false, objectKeys: [], threadIds: [] };
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
          return { purged: false, objectKeys: [], threadIds: [] };
        }
      }

      const [uploads, results, sourceRows] = await Promise.all([
        // The Work owns no uploads; its threads' chats do.
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
      // F10: the Work's branches end through the Discard kernel, after this proof and before
      // their rows go, so nothing they created stays live and their storage is released.
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
      // The Work's nodes end in the project's list, after their drafts and before their source
      // rows go: the browsers read "gone for good" from the `purge` record.
      const sources = new Set<string>(sourceRows.map(({ id }) => id));
      const { result: documentIds } = await deps.tree.submit({
        lists: [{ kind: "project", projectId: work.projectId }],
        make: ([{ writer }]) => purgeSources(writer, sources),
      });
      const released = await releaseDocumentContent(deps.db, documentIds);
      const objectKeys = [
        // The incoming object is where an upload's PUT lands; one never finished is still there.
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
        await deps.evidence.forgetThreads(lockedTree.threadIds);
      }
      // The disposed branches' rows go with the Work and its purged lineages; their closed drafts cascade.
      await activeDb
        .delete(branches)
        .where(
          or(
            eq(branches.originWorkId, workId),
            purgedRoots.length ? inArray(branches.originRootThreadId, purgedRoots) : undefined,
          ),
        );
      // A chat that moved to another Work keeps this Work's membership as non-primary history.
      // Its readers (the Work's chat list, the Work switcher's recent summary) filter by this Work,
      // which is gone after this. A primary membership still blocks the delete: those chats went above.
      await activeDb
        .delete(threadWorks)
        .where(and(eq(threadWorks.workId, workId), eq(threadWorks.isPrimary, false)));
      const deleted = await activeDb
        .delete(works)
        .where(and(eq(works.id, workId), lte(works.deletedAt, cutoff)))
        .returning({ id: works.id, entityRevision: works.entityRevision });
      if (deleted[0]) {
        // A snapshot's revision is the sum of the project's Work revisions, and clients keep the
        // highest they have seen. Deleting a row would lower the sum, so a client would keep
        // showing the purged Work: its revision, and one more, move to the project's No Work.
        await activeDb
          .update(works)
          .set({
            entityRevision: sql`${works.entityRevision} + ${String(deleted[0].entityRevision)}::bigint + 1`,
          })
          .where(and(eq(works.projectId, work.projectId), eq(works.isNoWork, true)));
        deps.works.lifecycleChanged({ id: workId, projectId: work.projectId });
      }
      return { purged: deleted.length > 0, objectKeys, threadIds: lockedTree.threadIds };
    });
  }

  return {
    async sweep(): Promise<number> {
      const currentTime = now();
      const cutoff = deletionPurgeCutoff(currentTime);
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
          // One Work's purge is its own unit: a Work that fails every pass stays, logged each pass,
          // and does not stop the Works deleted after it.
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
