/** In-memory Work branches: the same resolver semantics over a map, for in-memory composition. */
import { type BranchId, type DraftOwner, draftOwnerKey, type ThreadId } from "@meridian/contracts";
import type { Branch, BranchStore, BranchWriteBoundary } from "../../domain/ports/branch-store.js";

export function createInMemoryBranchStore(): BranchStore {
  const rows = new Map<BranchId, Branch>();
  const active = (branchId: BranchId) => {
    const row = rows.get(branchId);
    return row?.status === "active" ? row : null;
  };
  const ownerKeyOf = (row: Branch) =>
    row.originWorkId
      ? draftOwnerKey({ kind: "work", workId: row.originWorkId })
      : row.originRootThreadId
        ? draftOwnerKey({ kind: "lineage", rootThreadId: row.originRootThreadId })
        : null;
  const byOrigin = (owner: DraftOwner) =>
    [...rows.values()]
      .filter((row) => ownerKeyOf(row) === draftOwnerKey(owner))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const activeOf = (owner: DraftOwner) =>
    byOrigin(owner).find((row) => row.status === "active") ?? null;
  return {
    async ownerOf(branchId) {
      const branch = rows.get(branchId);
      if (!branch) return null;
      const owner: DraftOwner | null = branch.originWorkId
        ? { kind: "work", workId: branch.originWorkId }
        : branch.originRootThreadId
          ? {
              kind: "lineage",
              projectId: branch.projectId,
              rootThreadId: branch.originRootThreadId,
            }
          : null;
      return { branch, owner, handle: null, lifecycle: owner ? "active" : "missing" };
    },
    activeForOwner: async (owner) => activeOf(owner),
    // Lookup and insert with no await between them: one critical section.
    async ensureActiveLocked(input) {
      const existing = activeOf(input.owner);
      if (existing) return existing;
      const branch: Branch = {
        id: crypto.randomUUID() as BranchId,
        projectId: input.projectId,
        status: "active",
        originWorkId: input.owner.kind === "work" ? input.owner.workId : null,
        originRootThreadId: input.owner.kind === "lineage" ? input.owner.rootThreadId : null,
        originThreadId: input.originThreadId,
        createdBy: input.createdBy,
        createdAt: new Date(),
      };
      rows.set(branch.id, branch);
      return branch;
    },
    lockActive: async (branchId) => active(branchId),
    shareActive: async (branchId) => active(branchId),
    async close(branchId) {
      const row = rows.get(branchId);
      if (row) rows.set(branchId, { ...row, status: "closed" });
    },
    byIds: async (branchIds) => branchIds.flatMap((id) => rows.get(id) ?? []),
    byOriginWork: async (workId) => byOrigin({ kind: "work", workId }),
    activeByOriginLineages: async (rootThreadIds: readonly ThreadId[]) =>
      [...rows.values()].filter(
        (row) =>
          row.status === "active" &&
          row.originRootThreadId !== null &&
          rootThreadIds.includes(row.originRootThreadId),
      ),
  };
}

/** No owner rows in memory: every owner is active; a per-owner queue stands in for its lock. */
export function createInMemoryBranchWriteBoundary(): BranchWriteBoundary {
  const tails = new Map<string, Promise<unknown>>();
  return {
    withActiveOwnerLocked(owner, operation) {
      const key = draftOwnerKey(owner);
      const run = (tails.get(key) ?? Promise.resolve()).then(operation, operation);
      const tail = run.catch(() => undefined);
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return run;
    },
  };
}
