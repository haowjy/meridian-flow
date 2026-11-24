import type { Lease } from "./upload-presence";

export class UploadAttempt {
  private readonly controller = new AbortController();
  private readonly sending = new Map<number, number>();
  private handedOff = false;
  reporting?: Promise<boolean>;

  constructor(private readonly lease: Lease) {}

  get signal() {
    return this.controller.signal;
  }

  get ended() {
    return this.controller.signal.aborted;
  }

  progress(entryId: number, bytes: number) {
    this.sending.set(entryId, bytes);
    return [...this.sending.values()].reduce((sum, sent) => sum + sent, 0);
  }

  holdUntil(work: Promise<unknown>) {
    this.handedOff = true;
    void work.finally(() => this.end());
  }

  release() {
    if (!this.handedOff) this.end();
  }

  end() {
    if (this.ended) return;
    this.controller.abort();
    this.lease.release();
  }
}
