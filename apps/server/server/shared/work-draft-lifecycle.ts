/**
 * Seam B (file-access §5): serializes transitions that make draft rows reviewable, and the
 * one canonical branch → draft → Work mapping (contract §2.2) every reader of a branch's
 * Work goes through.
 */
import type { DraftId } from "@meridian/contracts";
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBranches, drafts } from "@meridian/database/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { WorkLifecycleUnavailableError } from "../domains/projects/domain/work-lifecycle.js";
import {
  currentDrizzleDb,
  type DrizzleDb,
  runInDrizzleTransaction,
} from "./drizzle-transaction.js";
import { lockSeamWorks, requireLockedActiveWorks } from "./work-lifecycle-lock.js";

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

export async function runWithActiveWorkDrafts<T>(
  db: Database,
  input: { workIds?: readonly WorkId[]; branchIds?: readonly string[] },
  operation: () => Promise<T>,
): Promise<T> {
  return runInDrizzleTransaction(db, async () => {
    const branchIds = new Set(input.branchIds ?? []);
    const branches = await draftBranchWorks(db, [...branchIds]);
    if (branches.length !== branchIds.size) throw new Error("Draft branch not found");
    // A draft whose origin Work is gone is frozen, as a missing Work is.
    const frozen = branches.find((row) => row.workId === null);
    if (frozen) throw new WorkLifecycleUnavailableError(frozen.draftId, "missing");
    await requireLockedActiveWorks(db, [
      ...(input.workIds ?? []),
      ...branches.flatMap((row) => (row.workId ? [row.workId] : [])),
    ]);
    return operation();
  });
}

/**
 * Seam B for a caller about to change several draft branches in one
 * transaction: locks their Works (with the bound grants' Works, then the
 * grants' confirmation) before any advisory lock, and names the branches whose
 * Work is no longer active (a draft with no origin Work among them). The locks
 * hold for the transaction, so each branch's own seam re-locks a Work it already holds.
 */
export async function lockDraftBranchWorks(
  db: Database,
  branchIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows = await draftBranchWorks(db, branchIds);
  const locked = await lockSeamWorks(
    db,
    rows.flatMap((row) => (row.workId ? [row.workId] : [])),
  );
  return new Set(
    rows
      .filter((row) => !row.workId || locked.get(row.workId)?.state !== "active")
      .map((row) => row.id),
  );
}
