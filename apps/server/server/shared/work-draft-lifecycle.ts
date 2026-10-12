/** Seam B (file-access §5): serializes transitions that make Work-owned draft rows reviewable. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "./drizzle-transaction.js";
import { lockSeamWorks, requireLockedActiveWorks } from "./work-lifecycle-lock.js";

/** The named draft branches that exist, each with its Work (null for none). */
async function branchWorks(
  db: Database,
  branchIds: readonly string[],
): Promise<{ id: string; workId: WorkId | null }[]> {
  if (branchIds.length === 0) return [];
  const rows = await currentDrizzleDb(db)
    .select({ id: documentBranches.id, workId: documentBranches.workId })
    .from(documentBranches)
    .where(inArray(documentBranches.id, [...new Set(branchIds)]));
  return rows.map((row) => ({ id: row.id, workId: row.workId as WorkId | null }));
}

export async function runWithActiveWorkDrafts<T>(
  db: Database,
  input: { workIds?: readonly WorkId[]; branchIds?: readonly string[] },
  operation: () => Promise<T>,
): Promise<T> {
  return runInDrizzleTransaction(db, async () => {
    const branchIds = new Set(input.branchIds ?? []);
    const branches = await branchWorks(db, [...branchIds]);
    if (branches.length !== branchIds.size) throw new Error("Draft branch not found");
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
 * Work is no longer active. The locks hold for the transaction, so each
 * branch's own seam re-locks a Work it already holds.
 */
export async function lockDraftBranchWorks(
  db: Database,
  branchIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const rows = await branchWorks(db, branchIds);
  const locked = await lockSeamWorks(
    db,
    rows.flatMap((row) => (row.workId ? [row.workId] : [])),
  );
  return new Set(
    rows
      .filter((row) => row.workId && locked.get(row.workId)?.state !== "active")
      .map((row) => row.id),
  );
}
