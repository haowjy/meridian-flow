/** A latency hint only; the durable organizing row is the queue's authority. */
export interface OrganizeWake {
  wake(importId: string): void;
}
