/** Tracks detached runtime promises so shutdown and test resets can drain them. */

export interface DetachedWorkTracker {
  track<T>(work: PromiseLike<T>): Promise<T>;
  drain(timeoutMs?: number): Promise<boolean>;
  readonly pendingCount: number;
}

export function createDetachedWorkTracker(): DetachedWorkTracker {
  const pending = new Set<Promise<void>>();

  function track<T>(work: PromiseLike<T>): Promise<T> {
    const task = Promise.resolve(work);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settled);
    void settled.then(() => pending.delete(settled));
    return task;
  }

  async function waitForQuiescence(): Promise<void> {
    while (pending.size > 0) await Promise.all([...pending]);
  }

  async function drain(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const settled = waitForQuiescence();
    if (!Number.isFinite(timeoutMs)) {
      await settled;
      return true;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(timeoutMs, 0));
    });
    const result = await Promise.race([settled.then(() => true as const), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  }

  return {
    track,
    drain,
    get pendingCount() {
      return pending.size;
    },
  };
}

/** Shared by manually composed runtimes and DB test resets; apps inject their own tracker. */
export const processDetachedWork = createDetachedWorkTracker();
