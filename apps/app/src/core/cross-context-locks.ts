/** Native Web Locks adaptation and callback-lifetime leases shared by browser owners. */
type LockMode = "shared" | "exclusive";
type LockRequestOptions =
  | { mode?: LockMode; signal?: AbortSignal; ifAvailable?: never }
  | { mode?: LockMode; ifAvailable: true; signal?: never };

export interface CrossContextLockManager {
  request<T>(
    name: string,
    options: LockRequestOptions,
    callback: (lock: unknown | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export function nativeLocks(): CrossContextLockManager | null {
  if (typeof navigator === "undefined") return null;
  const manager = navigator.locks;
  if (!manager || typeof manager.request !== "function") return null;
  return {
    request: (name, options, callback) =>
      manager.request(
        name,
        options as LockOptions,
        callback as (lock: Lock | null) => unknown,
      ) as Promise<never>,
  };
}

export async function tryAcquireExclusiveLock(
  locks: CrossContextLockManager,
  name: string,
): Promise<{ release(): Promise<void> } | null> {
  const acquired = deferred<{ release(): Promise<void> } | null>();
  const release = deferred<void>();
  const request = locks.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
    if (!lock) {
      acquired.resolve(null);
      return;
    }
    let released = false;
    acquired.resolve({
      release: async () => {
        if (!released) {
          released = true;
          release.resolve();
        }
        await request;
      },
    });
    await release.promise;
  });
  void request.catch(acquired.reject);
  return acquired.promise;
}
