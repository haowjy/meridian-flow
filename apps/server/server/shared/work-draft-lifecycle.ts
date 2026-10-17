/**
 * The one canonical branch → draft → Work mapping (contract §2.2) every reader of a branch's
 * Work goes through.
 */
import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import { documentBranches, drafts } from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
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
