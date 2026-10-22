/**
 * Drizzle adapter for Work branches. "One active branch per Work" is written in exactly two
 * statements here: `activeForWork`'s select and `ensureActiveLocked`'s insert-if-absent,
 * race-free because every caller holds the Work row lock.
 */
import type { BranchId, WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches } from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { assertBranchWriteJoinAllowed } from "../../../shared/branch-write-join.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branch, BranchStore, BranchWriteBoundary } from "../domain/ports/branch-store.js";

const branchColumns = {
  id: branches.id,
  projectId: branches.projectId,
  status: branches.status,
  originWorkId: branches.originWorkId,
  originThreadId: branches.originThreadId,
  createdBy: branches.createdBy,
  createdAt: branches.createdAt,
};

export function createDrizzleBranchStore(db: Database): BranchStore {
  const tx = () => currentDrizzleDb(db);

  async function activeForWork(workId: WorkId): Promise<Branch | null> {
    if (!isUuid(workId)) return null;
    const [row] = await tx()
      .select(branchColumns)
      .from(branches)
      .where(and(eq(branches.originWorkId, workId), eq(branches.status, "active")))
      .orderBy(asc(branches.createdAt), asc(branches.id))
      .limit(1);
    return row ?? null;
  }

  async function activeRow(branchId: BranchId, strength: "no key update" | "share") {
    if (!isUuid(branchId)) return null;
    const [row] = await tx()
      .select(branchColumns)
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.status, "active")))
      .for(strength);
    return row ?? null;
  }

  return {
    activeForWork,
    async ensureActiveLocked(input) {
      const existing = await activeForWork(input.workId);
      if (existing) return existing;
      const [created] = await tx()
        .insert(branches)
        .values({
          projectId: input.projectId,
          originWorkId: input.workId,
          originThreadId: input.originThreadId,
          createdBy: input.createdBy,
        })
        .returning(branchColumns);
      if (!created) throw new Error(`Branch insert for Work ${input.workId} returned no row`);
      return created;
    },
    lockActive: (branchId) => activeRow(branchId, "no key update"),
    shareActive: (branchId) => activeRow(branchId, "share"),
    async close(branchId, at) {
      await tx()
        .update(branches)
        .set({ status: "closed", closedAt: at })
        .where(and(eq(branches.id, branchId), eq(branches.status, "active")));
    },
    async byIds(branchIds) {
      const ids = [...new Set(branchIds)].filter(isUuid);
      if (ids.length === 0) return [];
      return tx().select(branchColumns).from(branches).where(inArray(branches.id, ids));
    },
    async byOriginWork(workId) {
      if (!isUuid(workId)) return [];
      return tx()
        .select(branchColumns)
        .from(branches)
        .where(eq(branches.originWorkId, workId))
        .orderBy(asc(branches.createdAt), asc(branches.id));
    },
  };
}

export function createDrizzleBranchWriteBoundary(
  db: Database,
  /** Work-first order's one owner (decision D17). */
  works: Pick<WorkProjectionMutation, "lockWorks">,
): BranchWriteBoundary {
  return {
    withActiveWorkLocked: (workId, operation) => {
      assertBranchWriteJoinAllowed();
      return runInDrizzleTransaction(db, async () => {
        await works.lockWorks({ works: [workId] }, { requireActive: true });
        return operation();
      });
    },
  };
}
