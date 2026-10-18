/**
 * The one canonical draft → branch → Work mapping (contract §2.2) every reader of a draft's
 * Work goes through.
 */
import type { BranchId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import { branches, documentDrafts } from "@meridian/database/schema";
import { eq, inArray } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "./drizzle-transaction.js";

export type BranchDraftRef = { id: string; branchId: BranchId; workId: WorkId | null };

/**
 * The mapping as a join, for a select that reads drafts anyway: `branches` on the branch's
 * draft, and the column that is the branch's Work.
 */
export const draftBranchWork = {
  branches,
  on: eq(branches.id, documentDrafts.branchId),
  workId: branches.originWorkId,
} as const;

/**
 * The named drafts that exist, each with its draft and that draft's origin Work. A
 * draft with no origin Work (a purge set it null) maps to `workId: null`: frozen.
 */
export async function branchDraftRefs(
  db: DrizzleDb,
  draftIds: readonly string[],
): Promise<BranchDraftRef[]> {
  if (draftIds.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({
      id: documentDrafts.id,
      branchId: documentDrafts.branchId,
      workId: draftBranchWork.workId,
    })
    .from(documentDrafts)
    .innerJoin(draftBranchWork.branches, draftBranchWork.on)
    .where(inArray(documentDrafts.id, [...new Set(draftIds)]));
  return rows.map((row) => ({
    id: row.id,
    branchId: row.branchId,
    workId: (row.workId as WorkId | null) ?? null,
  }));
}
