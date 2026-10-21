/** In-memory Work branches: the same resolver semantics over a map, for in-memory composition. */
import type { BranchId, WorkId } from "@meridian/contracts";
import type { Branch, BranchStore, BranchWriteBoundary } from "../../domain/ports/branch-store.js";

export function createInMemoryBranchStore(): BranchStore {
  const rows = new Map<BranchId, Branch>();
  const active = (branchId: BranchId) => {
    const row = rows.get(branchId);
    return row?.status === "active" ? row : null;
  };
  const byOrigin = (workId: WorkId) =>
    [...rows.values()]
      .filter((row) => row.originWorkId === workId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  const activeOf = (workId: WorkId) =>
    byOrigin(workId).find((row) => row.status === "active") ?? null;
  return {
    activeForWork: async (workId) => activeOf(workId),
    // Lookup and insert with no await between them: one critical section.
    async ensureActiveLocked(input) {
      const existing = activeOf(input.workId);
      if (existing) return existing;
      const branch: Branch = {
        id: crypto.randomUUID() as BranchId,
        projectId: input.projectId,
        status: "active",
        originWorkId: input.workId,
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
    byOriginWork: async (workId) => byOrigin(workId),
  };
}

/** No Work rows in memory: every Work is active; a per-Work queue stands in for its row lock. */
export function createInMemoryBranchWriteBoundary(): BranchWriteBoundary {
  const tails = new Map<WorkId, Promise<unknown>>();
  return {
    withActiveWorkLocked(workId, operation) {
      const run = (tails.get(workId) ?? Promise.resolve()).then(operation, operation);
      const tail = run.catch(() => undefined);
      tails.set(workId, tail);
      void tail.then(() => {
        if (tails.get(workId) === tail) tails.delete(workId);
      });
      return run;
    },
  };
}
