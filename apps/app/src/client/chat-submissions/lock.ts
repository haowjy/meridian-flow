/** Per-thread submission ownership; cancellation releases queued owners. */
export interface SubmissionLock {
  run<T>(
    accountId: string,
    threadId: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>;
}

/** Bound even adapters that do not themselves honour cancellation. Late results are ignored. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function submissionLockName(accountId: string, threadId: string): string {
  return `meridian:chat-submissions:${accountId}:${threadId}`;
}
