/**
 * The one canonical branch → draft → Work mapping (contract §2.2) every reader of a branch's
 * Work goes through, and the fence a Work's lifecycle transition puts on its branches.
 */
import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import { documentBranches, drafts } from "@meridian/database/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

export type DraftBranchWork = { id: string; draftId: DraftId; workId: WorkId | null };

/**
 * The mapping as a join, for a select that reads branches anyway: `drafts` on the branch's
 * draft, and the column that is the branch's Work.
 */
export const branchDraftWork = {
  drafts,
  on: eq(drafts.id, documentBranches.draftId),
  workId: drafts.originWorkId,
} as const;

/**
 * The named branches that exist, each with its draft and that draft's origin Work. A
 * draft with no origin Work (a purge set it null) maps to `workId: null`: frozen.
 */
export async function draftBranchWorks(
  db: DrizzleDb,
  branchIds: readonly string[],
): Promise<DraftBranchWork[]> {
  if (branchIds.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({
      id: documentBranches.id,
      draftId: documentBranches.draftId,
      workId: branchDraftWork.workId,
    })
    .from(documentBranches)
    .innerJoin(branchDraftWork.drafts, branchDraftWork.on)
    .where(inArray(documentBranches.id, [...new Set(branchIds)]));
  return rows.map((row) => ({
    id: row.id,
    draftId: row.draftId,
    workId: (row.workId as WorkId | null) ?? null,
  }));
}

/** The origin Works of these drafts that have one, as the pending projection maps a draft. */
export async function draftOriginWorkIds(
  db: DrizzleDb,
  draftIds: readonly DraftId[],
): Promise<WorkId[]> {
  const ids = [...new Set(draftIds)];
  if (ids.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({ workId: drafts.originWorkId })
    .from(drafts)
    .where(inArray(drafts.id, ids));
  return rows.flatMap(({ workId }) => (workId ? [workId as WorkId] : []));
}

/**
 * A Work lifecycle transition (archive, unarchive, delete, restore) is a write to every
 * branch the Work owns: inside the transition's Work-locked transaction, its active branches
 * (Work drafts and the thread peers on their drafts) are locked in id order and their
 * `revision` bumped, so a branch write judged before the transition misses its predicate
 * rather than committing after it. The order is Work, then branch rows (decision D11).
 */
export async function fenceWorkBranches(db: DrizzleDb, workId: WorkId): Promise<void> {
  const tx = currentDrizzleDb(db);
  const locked = await tx
    .select({ id: documentBranches.id })
    .from(documentBranches)
    .innerJoin(branchDraftWork.drafts, branchDraftWork.on)
    .where(and(eq(branchDraftWork.workId, workId), eq(documentBranches.status, "active")))
    .orderBy(asc(documentBranches.id))
    .for("update", { of: documentBranches });
  if (!locked.length) return;
  await tx
    .update(documentBranches)
    .set({ revision: sql`${documentBranches.revision} + 1` })
    .where(
      inArray(
        documentBranches.id,
        locked.map((row) => row.id),
      ),
    );
}
