export class KeyedMutex {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(
    key: string,
    fn: () => Promise<T>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let acquired = false;
    let cancelled: Error | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectCancellation!: (cause: Error) => void;
    const cancellation = new Promise<never>((_, reject) => {
      rejectCancellation = reject;
    });
    const cancel = (cause: Error) => {
      if (acquired || cancelled) return;
      cancelled = cause;
      rejectCancellation(cause);
    };
    const onAbort = () => cancel(new Error(`Lock acquisition aborted for ${key}.`));
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(
        () => cancel(new Error(`Timed out acquiring lock for ${key}.`)),
        options.timeoutMs,
      );
    }
    const invoke = () => {
      if (cancelled) throw cancelled;
      acquired = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      return fn();
    };
    const run = prev.then(invoke, invoke);
    let guard: Promise<unknown>;
    const cleanup = () => {
      if (this.chains.get(key) === guard) {
        this.chains.delete(key);
      }
    };
    guard = run.then(cleanup, cleanup);
    this.chains.set(key, guard);
    void run.catch(() => {});
    return Promise.race([run, cancellation]).finally(() => {
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
    });
  }
}
