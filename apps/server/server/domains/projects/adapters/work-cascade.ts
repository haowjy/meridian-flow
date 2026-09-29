/** Table-driven soft-delete and restore cascade for rows owned by a Work. */
import type { ContextSourceId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import {
  contextSources,
  documentBranches,
  documents,
  folders,
  projectResults,
  threads,
} from "@meridian/database/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";

type WorkCascadeInput = {
  workId: WorkId;
  threadIds: readonly ThreadId[];
  liveThreadIds: readonly ThreadId[];
  at: Date;
};

type CascadeContext = WorkCascadeInput & {
  db: DrizzleDb;
  sourceIds: readonly ContextSourceId[];
};

type WorkCascadeEntry = {
  name: string;
  hide(context: CascadeContext): Promise<readonly ThreadId[] | undefined>;
  unhide(context: CascadeContext): Promise<void>;
};

const WORK_CASCADE: readonly WorkCascadeEntry[] = [
  {
    name: "threads",
    async hide({ db, workId, liveThreadIds, at }) {
      if (liveThreadIds.length === 0) return [];
      const rows = await currentDrizzleDb(db)
        .update(threads)
        .set({ deletedAt: at, deletedByWorkId: workId, updatedAt: at })
        .where(and(inArray(threads.id, [...liveThreadIds]), isNull(threads.deletedAt)))
        .returning({ id: threads.id });
      return rows.map(({ id }) => id);
    },
    async unhide({ db, workId, at }) {
      await currentDrizzleDb(db)
        .update(threads)
        .set({ deletedAt: null, deletedByWorkId: null, updatedAt: at })
        .where(eq(threads.deletedByWorkId, workId));
    },
  },
  {
    name: "project results",
    async hide({ db, workId, threadIds }) {
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
    async unhide({ db, workId }) {
      await currentDrizzleDb(db)
        .update(projectResults)
        .set({ deletedByWorkId: null })
        .where(eq(projectResults.deletedByWorkId, workId));
    },
  },
  {
    name: "documents",
    async hide({ db, workId, sourceIds, at }) {
      if (sourceIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(documents)
        .set({ deletedAt: at, deletedByWorkId: workId })
        .where(
          and(inArray(documents.contextSourceId, [...sourceIds]), isNull(documents.deletedAt)),
        );
    },
    async unhide({ db, workId }) {
      await currentDrizzleDb(db)
        .update(documents)
        .set({ deletedAt: null, deletedByWorkId: null })
        .where(eq(documents.deletedByWorkId, workId));
    },
  },
  {
    name: "folders",
    async hide({ db, workId, sourceIds, at }) {
      if (sourceIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(folders)
        .set({ deletedAt: at, deletedByWorkId: workId })
        .where(and(inArray(folders.contextSourceId, [...sourceIds]), isNull(folders.deletedAt)));
    },
    async unhide({ db, workId }) {
      await currentDrizzleDb(db)
        .update(folders)
        .set({ deletedAt: null, deletedByWorkId: null })
        .where(eq(folders.deletedByWorkId, workId));
    },
  },
  {
    name: "context sources",
    async hide({ db, workId, sourceIds, at }) {
      if (sourceIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(contextSources)
        .set({ deletedAt: at, deletedByWorkId: workId })
        .where(and(inArray(contextSources.id, [...sourceIds]), isNull(contextSources.deletedAt)));
    },
    async unhide({ db, workId }) {
      await currentDrizzleDb(db)
        .update(contextSources)
        .set({ deletedAt: null, deletedByWorkId: null })
        .where(eq(contextSources.deletedByWorkId, workId));
    },
  },
  {
    name: "Work draft branches",
    async hide({ db, workId, at }) {
      await currentDrizzleDb(db)
        .update(documentBranches)
        .set({ status: "closed", deletedByWorkId: workId, updatedAt: at })
        .where(
          and(
            eq(documentBranches.workId, workId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        );
    },
    async unhide({ db, workId, at }) {
      await currentDrizzleDb(db)
        .update(documentBranches)
        .set({ status: "active", deletedByWorkId: null, updatedAt: at })
        .where(eq(documentBranches.deletedByWorkId, workId));
    },
  },
];

async function cascadeContext(
  db: DrizzleDb,
  input: Omit<CascadeContext, "db" | "sourceIds">,
): Promise<CascadeContext> {
  const sources = await currentDrizzleDb(db)
    .select({ id: contextSources.id })
    .from(contextSources)
    .where(and(eq(contextSources.workId, input.workId), isNull(contextSources.deletedAt)));
  return { db, ...input, sourceIds: sources.map(({ id }) => id) };
}

export async function hideWorkOwnedRows(
  db: DrizzleDb,
  input: Omit<CascadeContext, "db" | "sourceIds">,
): Promise<ThreadId[]> {
  const context = await cascadeContext(db, input);
  const hiddenThreads: ThreadId[] = [];
  for (const entry of WORK_CASCADE) {
    const ids = await entry.hide(context);
    if (ids) hiddenThreads.push(...ids);
  }
  return hiddenThreads;
}

export async function unhideWorkOwnedRows(
  db: DrizzleDb,
  input: Omit<CascadeContext, "db" | "sourceIds">,
): Promise<void> {
  const context: CascadeContext = { db, ...input, sourceIds: [] };
  for (const entry of WORK_CASCADE) await entry.unhide(context);
}
