/** Table-driven soft-delete and restore cascade for rows owned by a Work. */

import type { ContextSourceId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  contextSources,
  documents,
  folders,
  projectResults,
  threads,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { lockContextNamespaces } from "../../context/adapters/context-fs/document-locations.js";
import type { DocumentRemoval } from "../../context/ports/document-removal.js";
import { lockDocuments } from "../../context/tree/node-rows.js";
import {
  loadActiveBranchUses,
  loadLivingSourceDocumentIds,
} from "../../context/tree/tree-view-sql.js";

type WorkCascadeInput = {
  removal: DocumentRemoval;
  workId: WorkId;
  projectId: ProjectId;
  threadIds: readonly ThreadId[];
  liveThreadIds: readonly ThreadId[];
  at: Date;
};

type CascadeContext = WorkCascadeInput & {
  db: Database;
  sourceIds: readonly ContextSourceId[];
};

type WorkCascadeEntry = {
  name: string;
  cascadeDelete(context: CascadeContext): Promise<readonly ThreadId[] | undefined>;
  cascadeRestore(context: CascadeContext): Promise<void>;
};

const WORK_CASCADE: readonly WorkCascadeEntry[] = [
  {
    name: "threads",
    async cascadeDelete({ db, workId, liveThreadIds, at }) {
      if (liveThreadIds.length === 0) return [];
      const rows = await currentDrizzleDb(db)
        .update(threads)
        .set({ deletedAt: at, deletedByWorkId: workId, updatedAt: at })
        .where(and(inArray(threads.id, [...liveThreadIds]), isNull(threads.deletedAt)))
        .returning({ id: threads.id });
      return rows.map(({ id }) => id);
    },
    async cascadeRestore({ db, workId, at }) {
      await currentDrizzleDb(db)
        .update(threads)
        .set({ deletedAt: null, deletedByWorkId: null, updatedAt: at })
        .where(eq(threads.deletedByWorkId, workId));
    },
  },
  {
    name: "project results",
    async cascadeDelete({ db, workId, threadIds }) {
      if (threadIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(projectResults)
        .set({ deletedByWorkId: workId })
        .where(
          and(
            or(
              inArray(projectResults.threadId, [...threadIds]),
              inArray(projectResults.rootThreadId, [...threadIds]),
            ),
            isNull(projectResults.deletedByWorkId),
          ),
        );
    },
    async cascadeRestore({ db, workId }) {
      await currentDrizzleDb(db)
        .update(projectResults)
        .set({ deletedByWorkId: null })
        .where(eq(projectResults.deletedByWorkId, workId));
    },
  },
  {
    name: "documents",
    async cascadeDelete({ db, workId, sourceIds, at, removal }) {
      if (!sourceIds.length) return;
      const documentIds = await loadLivingSourceDocumentIds(currentDrizzleDb(db), sourceIds);
      await lockDocuments(db, documentIds);
      await removal.remove({ documentIds, reason: "deleted", workId, at });
    },
    async cascadeRestore({ db, workId, removal }) {
      const restored = await currentDrizzleDb(db)
        .update(documents)
        .set({
          deletedAt: null,
          deletionReason: null,
          deletedByUserId: null,
          deletionCause: null,
          deletedByWorkId: null,
          locationVersion: sql`${documents.locationVersion} + 1`,
        })
        .where(eq(documents.deletedByWorkId, workId))
        .returning({ id: documents.id });
      const uses = await loadActiveBranchUses(
        currentDrizzleDb(db),
        restored.map(({ id }) => id),
      );
      removal.recount([
        ...new Set(uses.flatMap(({ originWorkId }) => (originWorkId ? [originWorkId] : []))),
      ]);
    },
  },
  {
    name: "folders",
    async cascadeDelete({ db, workId, sourceIds, at }) {
      if (sourceIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(folders)
        .set({
          deletedAt: at,
          deletedByWorkId: workId,
          locationVersion: sql`${folders.locationVersion} + 1`,
        })
        .where(and(inArray(folders.contextSourceId, [...sourceIds]), isNull(folders.deletedAt)));
    },
    async cascadeRestore({ db, workId }) {
      await currentDrizzleDb(db)
        .update(folders)
        .set({
          deletedAt: null,
          deletedByWorkId: null,
          locationVersion: sql`${folders.locationVersion} + 1`,
        })
        .where(eq(folders.deletedByWorkId, workId));
    },
  },
  {
    name: "context sources",
    async cascadeDelete({ db, workId, sourceIds, at }) {
      if (sourceIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(contextSources)
        .set({ deletedAt: at, deletedByWorkId: workId })
        .where(and(inArray(contextSources.id, [...sourceIds]), isNull(contextSources.deletedAt)));
    },
    async cascadeRestore({ db, workId }) {
      await currentDrizzleDb(db)
        .update(contextSources)
        .set({ deletedAt: null, deletedByWorkId: null })
        .where(eq(contextSources.deletedByWorkId, workId));
    },
  },
];

async function cascadeContext(
  db: Database,
  input: Omit<CascadeContext, "db" | "sourceIds">,
): Promise<CascadeContext> {
  const sources = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(and(eq(contextSources.workId, input.workId), isNull(contextSources.deletedAt)));
  return { db, ...input, sourceIds: sources.map(({ id }) => id) };
}

export async function cascadeDelete(
  db: Database,
  input: Omit<CascadeContext, "db" | "sourceIds">,
): Promise<ThreadId[]> {
  const context = await cascadeContext(db, input);
  await lockContextNamespaces(db, { projectId: input.projectId, userId: "" }, [], {
    sourceIds: context.sourceIds,
  });
  const cascadedThreads: ThreadId[] = [];
  for (const entry of WORK_CASCADE) {
    const ids = await entry.cascadeDelete(context);
    if (ids) cascadedThreads.push(...ids);
  }
  return cascadedThreads;
}

export async function cascadeRestore(
  db: Database,
  input: Omit<CascadeContext, "db" | "sourceIds">,
): Promise<void> {
  const context: CascadeContext = { db, ...input, sourceIds: [] };
  for (const entry of WORK_CASCADE) await entry.cascadeRestore(context);
}
