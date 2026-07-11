/** Owns serialization for branch mutations and provides proof of held locks. */
import { AsyncLocalStorage } from "node:async_hooks";
import { KeyedMutex } from "../../../shared/keyed-mutex.js";

const leaseMarker: unique symbol = Symbol("BranchLockLease");

export type BranchLockLease = {
  readonly [leaseMarker]: true;
  covers(branchId: string): boolean;
};

export type BranchCriticalSections = {
  withBranches<T>(
    branchIds: readonly string[],
    run: (lease: BranchLockLease) => Promise<T>,
  ): Promise<T>;
};

export function createBranchCriticalSections(mutex = new KeyedMutex()): BranchCriticalSections {
  const activeBranches = new AsyncLocalStorage<ReadonlySet<string>>();

  return {
    async withBranches<T>(
      branchIds: readonly string[],
      run: (lease: BranchLockLease) => Promise<T>,
    ): Promise<T> {
      const orderedIds = [...new Set(branchIds)].sort();
      const active = activeBranches.getStore();
      const overlap = orderedIds.find((branchId) => active?.has(branchId));
      if (overlap) {
        throw new Error(`Branch lock re-entry is not allowed for ${overlap}.`);
      }

      const held = new Set([...(active ?? []), ...orderedIds]);
      const lease: BranchLockLease = {
        [leaseMarker]: true,
        covers: (branchId) => orderedIds.includes(branchId),
      };
      const acquire = async (index: number): Promise<T> => {
        const branchId = orderedIds[index];
        if (!branchId) return activeBranches.run(held, () => run(lease));
        return mutex.run(branchId, () => acquire(index + 1));
      };
      return acquire(0);
    },
  };
}

export function assertBranchLeaseCovers(lease: BranchLockLease, branchId: string): void {
  if (!lease.covers(branchId)) throw new Error(`Branch lock lease does not cover ${branchId}.`);
}
