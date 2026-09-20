/**
 * Delivery pump — the shared flush/sweep scaffold for durable per-thread
 * deliveries.
 *
 * A durable delivery records an obligation, then a post-commit wake or interval
 * sweep flushes the owning thread. Two deliveries (the Work-context refresh and
 * the background child-report continuation) share that shape: concurrent flushes
 * of the same thread must serialize, an actively running thread must not be
 * disturbed, and the sweep fans out over every pending thread. The pump owns
 * exactly those three concerns; each transport supplies what "deliver this
 * thread" means and how its pending obligations are listed.
 */
import type { ThreadId } from "@meridian/contracts/runtime";

export interface DeliveryPump {
  flush(threadId: ThreadId): Promise<void>;
  sweep(): Promise<void>;
}

export interface DeliveryPumpInput {
  isThreadRunning(threadId: ThreadId): boolean;
  /** Threads with a durable obligation awaiting delivery. */
  listPendingThreadIds(): Promise<ThreadId[]>;
  /** Delivers every pending obligation for one thread; owns its own atomicity. */
  deliver(threadId: ThreadId): Promise<void>;
}

export function createDeliveryPump(input: DeliveryPumpInput): DeliveryPump {
  const flushChains = new Map<string, Promise<void>>();

  async function flushUnlocked(threadId: ThreadId): Promise<void> {
    if (input.isThreadRunning(threadId)) return;
    await input.deliver(threadId);
  }

  async function flush(threadId: ThreadId): Promise<void> {
    const key = threadId as string;
    const previous = flushChains.get(key) ?? Promise.resolve();
    const next = previous.then(() => flushUnlocked(threadId));
    const settled = next.catch(() => undefined);
    flushChains.set(key, settled);
    try {
      await next;
    } finally {
      if (flushChains.get(key) === settled) flushChains.delete(key);
    }
  }

  return {
    flush,
    async sweep() {
      const threadIds = await input.listPendingThreadIds();
      await Promise.all(threadIds.map(flush));
    },
  };
}
