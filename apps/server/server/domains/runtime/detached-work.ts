/** Tracks detached runtime promises so shutdown and test resets can drain them. */

export interface DetachedWorkTracker {
  track<T>(work: PromiseLike<T>, name?: string): Promise<T>;
  drain(timeoutMs?: number): Promise<boolean>;
  readonly pendingCount: number;
  readonly pendingTasks: readonly string[];
}

export function createDetachedWorkTracker(): DetachedWorkTracker {
  const pending = new Map<Promise<void>, string>();

  function track<T>(work: PromiseLike<T>, name = "runtime background task"): Promise<T> {
    const task = Promise.resolve(work);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    pending.set(settled, name);
    void settled.then(() => pending.delete(settled));
    return task;
  }

  async function waitForQuiescence(): Promise<void> {
    while (pending.size > 0) {
      await Promise.all(pending.keys());
      if (pending.size > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
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
    get pendingTasks() {
      return [...pending.values()];
    },
  };
}

/** Shared by manually composed runtimes and DB test resets; apps inject their own tracker. */
export const processDetachedWork = createDetachedWorkTracker();
