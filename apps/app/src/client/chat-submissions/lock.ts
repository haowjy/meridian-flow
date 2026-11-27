export interface SubmissionLock {
  run<T>(
    accountId: string,
    threadId: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>;
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function submissionLockName(accountId: string, threadId: string): string {
  return `meridian:chat-submissions:${accountId}:${threadId}`;
}
