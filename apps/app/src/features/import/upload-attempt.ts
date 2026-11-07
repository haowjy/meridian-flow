/**
 * One try at moving an import's files: reading, creating, matching, sending and hashing. It owns
 * the tab's presence lease and an abort signal, and ends both together, so "this tab is working on
 * the import" is exactly "an attempt on it is alive". Superseding or cancelling an attempt is
 * calling `end()` on it; late answers are told apart by `ended`, not by a counter.
 */
import type { Lease } from "./upload-presence";

export class UploadAttempt {
  private readonly controller = new AbortController();
  private readonly sending = new Map<number, number>();
  private handedOff = false;
  /** The hash pass for the re-picked received files, while this attempt runs one. */
  reporting?: Promise<boolean>;

  constructor(private readonly lease: Lease) {}

  /** Aborts when the attempt ends: every request and read tied to it stops. */
  get signal() {
    return this.controller.signal;
  }

  get ended() {
    return this.controller.signal.aborted;
  }

  /** Bytes in flight across the attempt's requests, once `entryId`'s request has sent `bytes`. */
  progress(entryId: number, bytes: number) {
    this.sending.set(entryId, bytes);
    return [...this.sending.values()].reduce((sum, sent) => sum + sent, 0);
  }

  /** Keep the attempt, and the lease, past the command that opened it until `work` settles. */
  holdUntil(work: Promise<unknown>) {
    this.handedOff = true;
    void work.finally(() => this.end());
  }

  /** The command that opened the attempt returned: end it unless it handed work off. */
  release() {
    if (!this.handedOff) this.end();
  }

  end() {
    if (this.ended) return;
    this.controller.abort();
    this.lease.release();
  }
}
