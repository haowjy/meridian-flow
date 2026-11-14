/**
 * Table-driven soft-delete and restore cascade for rows owned by a Work. A Work's sources are not
 * in it: a deleted Work's Scratch stays readable, read-only, until the Work is purged, as an
 * archived Work's does; its writes are refused by the Work's own lifecycle. The caller holds the
 * project's tree list lock (`lockProjectTreeList`), after the Work rows.
 */

import type { ProjectId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { projectResults, threads } from "@meridian/database/schema";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";

type WorkCascadeInput = {
  workId: WorkId;
  projectId: ProjectId;
  threadIds: readonly ThreadId[];
  liveThreadIds: readonly ThreadId[];
  at: Date;
};

type CascadeContext = WorkCascadeInput & { db: Database };

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
];

export async function cascadeDelete(db: Database, input: WorkCascadeInput): Promise<void> {
  for (const entry of WORK_CASCADE) await entry.cascadeDelete({ db, ...input });
}

export async function cascadeRestore(db: Database, input: WorkCascadeInput): Promise<void> {
  for (const entry of WORK_CASCADE) await entry.cascadeRestore({ db, ...input });
}
