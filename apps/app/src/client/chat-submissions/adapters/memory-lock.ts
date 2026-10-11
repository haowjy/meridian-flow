/** FIFO lock adapter for isolated scenarios, shared by their simulated tabs. */
import { abortable, type SubmissionLock, submissionLockName } from "../lock";

export class MemorySubmissionLock implements SubmissionLock {
  private tails = new Map<string, Promise<void>>();

  async run<T>(
    accountId: string,
    threadId: string,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    const name = submissionLockName(accountId, threadId);
    const previous = this.tails.get(name) ?? Promise.resolve();
    let release!: () => void;
    const completed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => completed);
    this.tails.set(name, tail);
    try {
      await abortable(previous, signal);
      signal.throwIfAborted();
      return await operation();
    } finally {
      release();
      void tail.then(() => {
        if (this.tails.get(name) === tail) this.tails.delete(name);
      });
    }
  }
}
