/**
 * Per-key trailing debounce with a maximum wait: many `schedule(key)` calls become one `run(key)`,
 * never two at once for a key. A schedule that fires while its key runs makes one more run
 * right after. Timers are hints: callers keep a sweep for what a restart or a stop dropped.
 */

/** What a run asks for next: `again` runs at once, `retry` runs after a backoff (see `backoff`). */
export type CoalescedRun = void | "again" | "retry";

export type KeyedCoalescer<K> = {
  /** Restarts the key's debounce; the first schedule since its last run also starts the maximum wait. */
  schedule(key: K): void;
  /** The key is scheduled, queued, running or backing off. */
  has(key: K): boolean;
  /** Runs every scheduled key now, and resolves once none is scheduled or running. */
  flush(): Promise<void>;
  /** Drops what hasn't started; runs in flight finish. */
  cancel(): void;
  /** Cancels, ignores later schedules, and joins runs in flight. */
  stop(): Promise<void>;
};

export function createKeyedCoalescer<K>(options: {
  debounceMs: number;
  /** Continuous scheduling starts a run within this long of the first unserved schedule. */
  maxMs?: number;
  /** At most this many keys run at once; later ones queue in arrival order. */
  maxConcurrent?: number;
  /** After a throw or a `retry`, run again after `baseMs * 2 ** (failures - 1)`, capped at `maxMs`. */
  backoff?: { baseMs: number; maxMs: number };
  /** Timers inherit the caller's async context, so a schedule made inside a transaction escapes it here. */
  outsideTransaction?<T>(operation: () => T): T;
  run(key: K): Promise<CoalescedRun>;
  onError(key: K, cause: unknown): void;
}): KeyedCoalescer<K> {
  type Entry = {
    debounce?: NodeJS.Timeout;
    max?: NodeJS.Timeout;
    running?: Promise<void>;
    queued: boolean;
    /** A timer fired while running. */
    again: boolean;
    failures: number;
  };
  const maxConcurrent = options.maxConcurrent ?? Number.POSITIVE_INFINITY;
  const entries = new Map<K, Entry>();
  const waiting: K[] = [];
  let active = 0;
  let stopped = false;

  const outside = options.outsideTransaction ?? ((operation) => operation());
  const pending = (entry: Entry) => entry.debounce !== undefined || entry.max !== undefined;

  function timer(key: K, ms: number): NodeJS.Timeout {
    const handle = setTimeout(() => fire(key), ms);
    handle.unref();
    return handle;
  }

  function clearTimers(entry: Entry) {
    clearTimeout(entry.debounce);
    clearTimeout(entry.max);
    entry.debounce = undefined;
    entry.max = undefined;
  }

  function fire(key: K) {
    const entry = entries.get(key);
    if (!entry || stopped) return;
    clearTimers(entry);
    if (entry.running) entry.again = true;
    else dispatch(key, entry);
  }

  function dispatch(key: K, entry: Entry) {
    if (entry.queued) return;
    if (active < maxConcurrent) start(key, entry);
    else {
      entry.queued = true;
      waiting.push(key);
    }
  }

  function start(key: K, entry: Entry) {
    entry.queued = false;
    entry.again = false;
    active += 1;
    entry.running = (async () => {
      try {
        return await options.run(key);
      } catch (cause) {
        options.onError(key, cause);
        return options.backoff ? ("retry" as const) : undefined;
      }
    })().then((outcome) => {
      entry.running = undefined;
      active -= 1;
      settle(key, entry, outcome);
      while (active < maxConcurrent && waiting.length) {
        const next = waiting.shift() as K;
        const queued = entries.get(next);
        if (queued) start(next, queued);
      }
    });
  }

  function settle(key: K, entry: Entry, outcome: CoalescedRun) {
    entry.failures = outcome === "retry" ? entry.failures + 1 : 0;
    if (stopped) {
      entries.delete(key);
    } else if (outcome === "again" || entry.again) {
      dispatch(key, entry);
    } else if (outcome === "retry" && options.backoff && !pending(entry)) {
      const { baseMs, maxMs } = options.backoff;
      entry.debounce = timer(key, Math.min(baseMs * 2 ** (entry.failures - 1), maxMs));
    } else if (!pending(entry)) {
      entries.delete(key);
    }
  }

  function cancel() {
    waiting.length = 0;
    for (const [key, entry] of entries) {
      clearTimers(entry);
      entry.again = false;
      entry.queued = false;
      if (!entry.running) entries.delete(key);
    }
  }

  return {
    schedule(key) {
      if (stopped) return;
      outside(() => {
        let entry = entries.get(key);
        if (!entry) {
          entry = { queued: false, again: false, failures: 0 };
          entries.set(key, entry);
        }
        clearTimeout(entry.debounce);
        entry.debounce = timer(key, options.debounceMs);
        if (options.maxMs !== undefined) entry.max ??= timer(key, options.maxMs);
      });
    },

    has: (key) => entries.has(key),

    async flush() {
      for (let round = 0; round < 1_000; round += 1) {
        if (stopped || entries.size === 0) return;
        for (const [key, entry] of entries) if (pending(entry)) fire(key);
        await Promise.all([...entries.values()].map((entry) => entry.running));
      }
      throw new Error("A keyed coalescer did not settle");
    },

    cancel,

    async stop() {
      stopped = true;
      cancel();
      await Promise.all([...entries.values()].map((entry) => entry.running));
    },
  };
}
