/** Coalesces overlapping catalog repair groups without splitting their atomic publication. */
import { type CatalogScope, catalogScopeKey } from "@meridian/contracts/protocol";

export type CatalogRepairRequest = {
  scopes: readonly CatalogScope[];
  invalidatedRootIds: readonly string[];
  availabilityGeneration: string;
  projectIds: readonly string[];
  userIds: readonly string[];
  sourceIds: readonly string[];
};

type PendingRepair = {
  keys: Set<string>;
  requests: CatalogRepairRequest[];
  waiters: Array<{ resolve(): void; reject(cause: unknown): void }>;
};

export function createCatalogRepairQueue(
  repair: (requests: readonly CatalogRepairRequest[]) => Promise<void>,
): { enqueue(request: CatalogRepairRequest): Promise<void> } {
  const active = new Set<string>();
  const pending: PendingRepair[] = [];

  function pump() {
    for (let index = 0; index < pending.length; ) {
      const batch = pending[index];
      if ([...batch.keys].some((key) => active.has(key))) {
        index++;
        continue;
      }
      pending.splice(index, 1);
      for (const key of batch.keys) active.add(key);
      // Reserve every scope before yielding. A bridging group waits for all its
      // scopes together rather than holding one while waiting for another.
      setImmediate(async () => {
        try {
          await repair(batch.requests);
          for (const waiter of batch.waiters) waiter.resolve();
        } catch (cause) {
          for (const waiter of batch.waiters) waiter.reject(cause);
        } finally {
          for (const key of batch.keys) active.delete(key);
          pump();
        }
      });
    }
  }

  return {
    enqueue(request) {
      return new Promise<void>((resolve, reject) => {
        const batch: PendingRepair = {
          keys: new Set(request.scopes.map(catalogScopeKey)),
          requests: [request],
          waiters: [{ resolve, reject }],
        };
        // Only pending work can cover a newer commit. Running batches stay frozen.
        for (let index = 0; index < pending.length; ) {
          const other = pending[index];
          if (![...other.keys].some((key) => batch.keys.has(key))) {
            index++;
            continue;
          }
          pending.splice(index, 1);
          for (const key of other.keys) batch.keys.add(key);
          batch.requests.push(...other.requests);
          batch.waiters.push(...other.waiters);
          index = 0;
        }
        pending.push(batch);
        pump();
      });
    },
  };
}
