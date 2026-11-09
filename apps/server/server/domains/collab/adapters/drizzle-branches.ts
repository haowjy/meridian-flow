/**
 * Drizzle adapter for branches. "One active branch per owner" is written in exactly two
 * statements here: `activeForOwner`'s select and `ensureActiveLocked`'s insert-if-absent,
 * race-free because every caller holds the owner lock (the Work row, or the lineage lock).
 */
import type { BranchId, DraftOwner, ThreadId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches } from "@meridian/database/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { assertBranchWriteJoinAllowed } from "../../../shared/branch-write-join.js";
import { branchOwnedBy, branchOwnerSql } from "../../../shared/draft-owner.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import { isUuid } from "../../../shared/uuid.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type { Branch, BranchStore, BranchWriteBoundary } from "../domain/ports/branch-store.js";

const branchColumns = {
  id: branches.id,
  projectId: branches.projectId,
  status: branches.status,
  originWorkId: branches.originWorkId,
  originRootThreadId: branches.originRootThreadId,
  originThreadId: branches.originThreadId,
  createdBy: branches.createdBy,
  createdAt: branches.createdAt,
};

export function createDrizzleBranchStore(db: Database): BranchStore {
  const tx = () => currentDrizzleDb(db);

  async function activeForOwner(owner: DraftOwner): Promise<Branch | null> {
    if (!isUuid(owner.kind === "work" ? owner.workId : owner.rootThreadId)) return null;
    const [row] = await tx()
      .select(branchColumns)
      .from(branches)
      .where(and(branchOwnedBy(owner), eq(branches.status, "active")))
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
    activeForOwner,
    async ownerOf(branchId) {
      if (!isUuid(branchId)) return null;
      const owner = branchOwnerSql(branches);
      const [row] = await tx()
        .select({ ...branchColumns, handle: owner.handle, lifecycle: owner.lifecycle })
        .from(branches)
        .where(eq(branches.id, branchId));
      if (!row) return null;
      const { handle, lifecycle, ...branch } = row;
      return {
        branch,
        owner: branch.originWorkId
          ? { kind: "work", workId: branch.originWorkId }
          : branch.originRootThreadId
            ? {
                kind: "lineage",
                projectId: branch.projectId,
                rootThreadId: branch.originRootThreadId,
              }
            : null,
        handle,
        lifecycle,
      };
    },
    async ensureActiveLocked(input) {
      const existing = await activeForOwner(input.owner);
      if (existing) return existing;
      const [created] = await tx()
        .insert(branches)
        .values({
          projectId: input.projectId,
          originWorkId: input.owner.kind === "work" ? input.owner.workId : null,
          originRootThreadId: input.owner.kind === "lineage" ? input.owner.rootThreadId : null,
          originThreadId: input.originThreadId,
          createdBy: input.createdBy,
        })
        .returning(branchColumns);
      if (!created)
        throw new Error(`Branch insert for owner ${JSON.stringify(input.owner)} returned no row`);
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
    async activeByOriginLineages(rootThreadIds: readonly ThreadId[]) {
      const ids = [...new Set(rootThreadIds)].filter(isUuid);
      if (ids.length === 0) return [];
      return tx()
        .select(branchColumns)
        .from(branches)
        .where(and(inArray(branches.originRootThreadId, ids), eq(branches.status, "active")))
        .orderBy(asc(branches.createdAt), asc(branches.id));
    },
  };
}

export function createDrizzleBranchWriteBoundary(
  db: Database,
  /** Owner-first order's one owner. */
  works: Pick<WorkProjectionMutation, "lockWorks">,
): BranchWriteBoundary {
  return {
    withActiveOwnerLocked: (owner, operation) => {
      assertBranchWriteJoinAllowed();
      return runInDrizzleTransaction(db, async () => {
        await works.lockWorks(
          owner.kind === "work" ? { works: [owner.workId] } : { lineages: [owner.rootThreadId] },
          { requireActive: true },
        );
        return operation();
      });
    },
  };
}
