/** Seam B (file-access §5): serializes transitions that make Work-owned draft rows reviewable. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "./drizzle-transaction.js";
import {
  lockSeamWorks,
  lockWorkLifecycle,
  requireLockedActiveWorks,
} from "./work-lifecycle-lock.js";

export async function runWithActiveWorkDrafts<T>(
  db: Database,
  input: { workIds?: readonly WorkId[]; branchIds?: readonly string[] },
  operation: () => Promise<T>,
): Promise<T> {
  return runInDrizzleTransaction(db, async () => {
    const branchIds = [...new Set(input.branchIds ?? [])];
    const branchRows =
      branchIds.length === 0
        ? []
        : await currentDrizzleDb(db)
            .select({ id: documentBranches.id, workId: documentBranches.workId })
            .from(documentBranches)
            .where(inArray(documentBranches.id, branchIds));
    if (branchRows.length !== branchIds.length) throw new Error("Draft branch not found");

    const workIds = [
      ...new Set([
        ...(input.workIds ?? []),
        ...branchRows.flatMap((row) => (row.workId ? [row.workId as WorkId] : [])),
      ]),
    ].sort();
    await requireLockedActiveWorks(db, workIds);
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
  const ids = [...new Set(branchIds)];
  const rows =
    ids.length === 0
      ? []
      : await currentDrizzleDb(db)
          .select({ id: documentBranches.id, workId: documentBranches.workId })
          .from(documentBranches)
          .where(inArray(documentBranches.id, ids));
  const workIds = [...new Set(rows.flatMap((row) => (row.workId ? [row.workId] : [])))];
  await lockSeamWorks(db, workIds);
  const inactiveWorks = new Set<string>();
  for (const workId of workIds) {
    if ((await lockWorkLifecycle(db, workId)) !== "active") inactiveWorks.add(workId);
  }
  return new Set(
    rows.filter((row) => row.workId && inactiveWorks.has(row.workId)).map((row) => row.id),
  );
}
