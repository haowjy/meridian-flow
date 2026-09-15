/** Short cross-context serialization for namespace dispatch and identity/terminal transitions. */
import type { ResourceNamespaceLock } from "@meridian/resource-replica";
import { type CrossContextLockManager, nativeLocks } from "@/core/cross-context-locks";

function lockName(accountId: string, handle: string): string {
  return `meridian:resource:v1:namespace/${[accountId, handle].map(encodeURIComponent).join("/")}`;
}

export function createResourceNamespaceLock(input: {
  accountId: string;
  epoch: AbortSignal;
  locks?: CrossContextLockManager | null;
}): ResourceNamespaceLock {
  const locks = input.locks === undefined ? nativeLocks() : input.locks;
  const requireOpen = () => {
    if (input.epoch.aborted) throw new Error("Resource namespace lock is closing");
  };
  return Object.freeze({
    accountId: input.accountId,
    async run<T>(key: { handle: string }, task: () => Promise<T>) {
      requireOpen();
      if (!locks) return { kind: "busy" as const };
      return locks.request(
        lockName(input.accountId, key.handle),
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          if (!lock) return { kind: "busy" as const };
          requireOpen();
          const value = await task();
          requireOpen();
          return { kind: "acquired" as const, value };
        },
      );
    },
  });
}
