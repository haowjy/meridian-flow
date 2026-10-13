/** Canonical pending draft count for Work projections and read adapters. */
import type { WorkId } from "@meridian/contracts/runtime";
import { branchWriteJournal, documentBranches } from "@meridian/database/schema";
import { and, countDistinct, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "./drizzle-transaction.js";

export async function countPendingWorkDrafts(
  db: DrizzleDb,
  workIds: readonly WorkId[],
): Promise<Map<WorkId, number>> {
  if (workIds.length === 0) return new Map();
  const rows = await db
    .select({ workId: documentBranches.workId, count: countDistinct(documentBranches.id) })
    .from(documentBranches)
    .innerJoin(
      branchWriteJournal,
      and(
        eq(branchWriteJournal.branchId, documentBranches.id),
        eq(branchWriteJournal.generation, documentBranches.generation),
        inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
      ),
    )
    .where(
      and(
        inArray(documentBranches.workId, workIds),
        eq(documentBranches.kind, "work_draft"),
        eq(documentBranches.status, "active"),
        sql`(${documentBranches.hasEffect} OR ${documentBranches.blocking})`,
        sql`((${branchWriteJournal.updateMeta}->>'kind') is distinct from 'manifest_membership'
            or jsonb_typeof(${branchWriteJournal.updateMeta}->'documentId') is distinct from 'string')`,
      ),
    )
    .groupBy(documentBranches.workId);
  return new Map(
    rows.flatMap(({ workId, count }) =>
      workId === null ? [] : [[workId as WorkId, Number(count)] as const],
    ),
  );
}
