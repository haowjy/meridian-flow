/**
 * ws-thread-subscription — the per-thread subscription registry for
 * `WsThreadTransport`.
 *
 * Tracks active subscriptions (handler sets, last-seen seq, gap counts, server
 * ack state), decides when to (re)send subscribe frames, and selects the newest
 * sequence. Owns subscription bookkeeping; the transport owns the socket.
 */
import { compareSeq } from "@meridian/contracts/protocol";

import type { ThreadTransportHandlers } from "./ThreadTransport";

export type ActiveThreadSubscription = {
  handlers: Set<ThreadTransportHandlers>;
  lastSeq?: string;
  gapCount: number;
  /** Server acknowledged subscribe/resume for this thread. */
  serverSubscribed: boolean;
};

export type EnsureSubscriptionResult = {
  subscription: ActiveThreadSubscription;
  /** Send a subscribe frame now (socket must be open). */
  sendSubscribe: boolean;
  /** Bypass the serverSubscribed short-circuit in sendSubscribe. */
  forceSubscribe: boolean;
};

export function selectNewestSeq(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSeq(a, b) >= 0 ? a : b;
}

export class WsThreadSubscriptionRegistry {
  private readonly subscriptions = new Map<string, ActiveThreadSubscription>();

  get(threadId: string): ActiveThreadSubscription | undefined {
    return this.subscriptions.get(threadId);
  }

  values(): IterableIterator<ActiveThreadSubscription> {
    return this.subscriptions.values();
  }

  entries(): IterableIterator<[string, ActiveThreadSubscription]> {
    return this.subscriptions.entries();
  }

  get size(): number {
    return this.subscriptions.size;
  }

  ensure(
    threadId: string,
    handlers: ThreadTransportHandlers,
    after?: string,
  ): EnsureSubscriptionResult {
    let subscription = this.subscriptions.get(threadId);
    const previousLastSeq = subscription?.lastSeq;
    const wasServerSubscribed = subscription?.serverSubscribed ?? false;

    if (!subscription) {
      subscription = {
        handlers: new Set(),
        lastSeq: after,
        gapCount: 0,
        serverSubscribed: false,
      };
      this.subscriptions.set(threadId, subscription);
      subscription.handlers.add(handlers);
      return {
        subscription,
        sendSubscribe: true,
        forceSubscribe: after !== undefined,
      };
    }

    if (after !== undefined) {
      const rewinding =
        subscription.lastSeq === undefined || compareSeq(after, subscription.lastSeq) < 0;
      if (rewinding) {
        subscription.lastSeq = after;
        subscription.serverSubscribed = false;
      } else {
        subscription.lastSeq = selectNewestSeq(subscription.lastSeq, after);
      }

      const cursorChanged =
        previousLastSeq === undefined || compareSeq(after, previousLastSeq) !== 0;
      subscription.handlers.add(handlers);
      return {
        subscription,
        sendSubscribe: rewinding || !wasServerSubscribed || cursorChanged,
        forceSubscribe: rewinding || cursorChanged,
      };
    }

    subscription.handlers.add(handlers);
    return {
      subscription,
      sendSubscribe: !wasServerSubscribed,
      forceSubscribe: false,
    };
  }

  /**
   * Removes a handler. Returns the subscription only when it was removed from the
   * registry (last handler gone); otherwise `null`.
   */
  removeHandler(
    threadId: string,
    handlers: ThreadTransportHandlers,
  ): ActiveThreadSubscription | null {
    const subscription = this.subscriptions.get(threadId);
    if (!subscription) return null;

    subscription.handlers.delete(handlers);
    if (subscription.handlers.size > 0) return null;

    this.subscriptions.delete(threadId);
    return subscription;
  }

  clearServerSubscribed(): void {
    for (const subscription of this.subscriptions.values()) {
      subscription.serverSubscribed = false;
    }
  }
}
