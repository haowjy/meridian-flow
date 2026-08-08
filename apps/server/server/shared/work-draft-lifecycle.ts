/** Serializes transitions that make Work-owned draft rows reviewable. */
import type { WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { documentBranches } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb, runInDrizzleTransaction } from "./drizzle-transaction.js";
import { requireLockedActiveWork } from "./work-lifecycle-lock.js";

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
    for (const workId of workIds) await requireLockedActiveWork(db, workId);
    return operation();
  });
}
