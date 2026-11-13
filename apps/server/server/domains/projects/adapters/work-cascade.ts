/**
 * Table-driven soft-delete and restore cascade for rows owned by a Work. A Work's Scratch is its
 * sources: the cascade ends and restores the source rows, and the list's replay follows them, so
 * it writes no node, and nothing of a document or a folder. The caller holds the project's tree
 * list lock (`lockProjectTreeList`), after the Work rows.
 */

import type { ContextSourceId, ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { contextSources, projectResults, threads } from "@meridian/database/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

type WorkCascadeInput = {
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
  cascadeDelete(context: CascadeContext): Promise<void>;
  cascadeRestore(context: CascadeContext): Promise<void>;
};

const WORK_CASCADE: readonly WorkCascadeEntry[] = [
  {
    name: "threads",
    async cascadeDelete({ db, workId, liveThreadIds, at }) {
      if (liveThreadIds.length === 0) return;
      await currentDrizzleDb(db)
        .update(threads)
        .set({ deletedAt: at, deletedByWorkId: workId, updatedAt: at })
        .where(and(inArray(threads.id, [...liveThreadIds]), isNull(threads.deletedAt)));
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
): Promise<void> {
  const context = await cascadeContext(db, input);
  for (const entry of WORK_CASCADE) await entry.cascadeDelete(context);
}

export async function cascadeRestore(
  db: Database,
  input: Omit<CascadeContext, "db" | "sourceIds">,
): Promise<void> {
  const context: CascadeContext = { db, ...input, sourceIds: [] };
  for (const entry of WORK_CASCADE) await entry.cascadeRestore(context);
}
