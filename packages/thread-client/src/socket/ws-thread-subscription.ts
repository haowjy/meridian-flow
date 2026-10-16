/**
 * ws-thread-subscription — the per-thread subscription registry for
 * `ThreadSocketClient`.
 *
 * Owns subscription bookkeeping and the delivery contract: each handler
 * receives every sequenced event after its own cursor, exactly once and in
 * `seq` order, whatever the timing between live frames and a replay. A handler
 * waiting on a replay (a rewind, a reconnect) is held behind a fence that the
 * server's `subscribed` frame releases. The transport owns the socket.
 */
import { compareSeq, type SequencedEvent } from "@meridian/contracts/protocol";

import type { ThreadTransportHandlers } from "./thread-transport";

/** Live frames held back, from sending a replay request until `subscribed`. */
type ReplayFence = {
  /** Handlers waiting on the replay now in flight. */
  waiting: Set<ThreadTransportHandlers>;
  /** Handlers whose replay request is queued behind the one in flight. */
  deferred: Set<ThreadTransportHandlers>;
  held: Map<string, SequencedEvent>;
};

export type ActiveThreadSubscription = {
  handlers: Set<ThreadTransportHandlers>;
  /** Per-handler delivery cursor: the last seq delivered, or the `after` it registered with. */
  cursors: Map<ThreadTransportHandlers, string | undefined>;
  /** Highest seq delivered to any handler: the subscription's current position. */
  lastSeq?: string;
  gapCount: number;
  /** Server acknowledged subscribe/resume for this thread. */
  serverSubscribed: boolean;
  /** A subscribe/resume was sent and its `subscribed` has not arrived. */
  replayInFlight: boolean;
  /** A subscribe was requested while one was in flight; resend on `subscribed`. */
  resendQueued: boolean;
  /**
   * The cursor the wire request now in flight carried (an omitted one is "0"). Neither `lastSeq`
   * nor the handlers' cursors can say what that replay will bring, so a handler added meanwhile is
   * judged against this. Set where the request is built; cleared when the replay ends.
   */
  requestedAfter?: string;
  fence?: ReplayFence;
};

export type EnsureSubscriptionResult = {
  subscription: ActiveThreadSubscription;
  /** Send a subscribe frame now (socket must be open). */
  sendSubscribe: boolean;
  /** Bypass the serverSubscribed short-circuit in sendSubscribe. */
  forceSubscribe: boolean;
  /** Handlers that must wait for the replay this subscribe will trigger. */
  waiters: ThreadTransportHandlers[];
};

export function selectNewestSeq(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSeq(a, b) >= 0 ? a : b;
}

/** The oldest cursor any handler still needs: the wire cursor for subscribe/resume. */
export function oldestCursor(subscription: ActiveThreadSubscription): string | undefined {
  let oldest: string | undefined;
  let first = true;
  for (const handler of subscription.handlers) {
    const cursor = subscription.cursors.get(handler);
    if (cursor === undefined) return undefined;
    if (first || compareSeq(cursor, oldest as string) < 0) oldest = cursor;
    first = false;
  }
  return first ? subscription.lastSeq : oldest;
}

function isHeld(subscription: ActiveThreadSubscription, handler: ThreadTransportHandlers): boolean {
  const fence = subscription.fence;
  return Boolean(fence && (fence.waiting.has(handler) || fence.deferred.has(handler)));
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

    if (!subscription) {
      subscription = {
        handlers: new Set([handlers]),
        cursors: new Map([[handlers, after]]),
        lastSeq: after,
        gapCount: 0,
        serverSubscribed: false,
        replayInFlight: false,
        resendQueued: false,
      };
      this.subscriptions.set(threadId, subscription);
      return {
        subscription,
        sendSubscribe: true,
        forceSubscribe: after !== undefined,
        waiters: [handlers],
      };
    }

    const wasServerSubscribed = subscription.serverSubscribed;
    const position = subscription.lastSeq;
    const requested = subscription.requestedAfter;
    if (
      wasServerSubscribed &&
      subscription.replayInFlight &&
      after !== undefined &&
      requested !== undefined &&
      compareSeq(after, requested) >= 0
    ) {
      // The replay in flight carries everything above `after`: wait for it with the live frames
      // held, so the catch-up reaches this handler before any live frame moves its cursor.
      subscription.handlers.add(handlers);
      subscription.cursors.set(handlers, after);
      const fence = subscription.fence ?? {
        waiting: new Set(),
        deferred: new Set(),
        held: new Map(),
      };
      subscription.fence = fence;
      fence.waiting.add(handlers);
      return { subscription, sendSubscribe: false, forceSubscribe: false, waiters: [] };
    }
    const rewinding =
      after !== undefined && (position === undefined || compareSeq(after, position) < 0);
    subscription.handlers.add(handlers);
    subscription.cursors.set(handlers, after ?? subscription.cursors.get(handlers) ?? position);

    let waiters: ThreadTransportHandlers[] = [];
    if (!wasServerSubscribed) waiters = [...subscription.handlers];
    else if (rewinding) waiters = [handlers];
    return {
      subscription,
      sendSubscribe: rewinding || !wasServerSubscribed,
      forceSubscribe: rewinding,
      waiters,
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
    subscription.cursors.delete(handlers);
    const fence = subscription.fence;
    if (fence) {
      fence.waiting.delete(handlers);
      fence.deferred.delete(handlers);
      if (fence.waiting.size === 0 && fence.deferred.size === 0) subscription.fence = undefined;
    }
    if (subscription.handlers.size > 0) return null;

    this.subscriptions.delete(threadId);
    return subscription;
  }

  /**
   * Holds `waiters` back from live delivery until the replay they need
   * arrives. Call just before sending a subscribe/resume.
   */
  holdForReplay(
    subscription: ActiveThreadSubscription,
    waiters: Iterable<ThreadTransportHandlers>,
  ): void {
    const handlers = [...waiters];
    if (handlers.length === 0) return;
    const fence = subscription.fence ?? {
      waiting: new Set(),
      deferred: new Set(),
      held: new Map(),
    };
    subscription.fence = fence;
    const target = subscription.replayInFlight ? fence.deferred : fence.waiting;
    for (const handler of handlers) target.add(handler);
  }

  /** A live frame: held for waiting handlers, delivered now to the rest. */
  accept(threadId: string, frame: SequencedEvent): void {
    const subscription = this.subscriptions.get(threadId);
    if (!subscription) return;
    subscription.fence?.held.set(frame.seq, frame);
    this.deliver(subscription, frame);
  }

  /**
   * The `subscribed` frame: merge its catch-up with the held live frames and
   * deliver them in `seq` order to the handlers that waited, then release the
   * fence. Returns true when a queued subscribe must now be sent.
   */
  settleReplay(threadId: string, catchup: SequencedEvent[]): boolean {
    const subscription = this.subscriptions.get(threadId);
    if (!subscription) return false;
    subscription.gapCount = 0;
    subscription.serverSubscribed = true;
    subscription.replayInFlight = false;
    subscription.requestedAfter = undefined;

    const fence = subscription.fence;
    let frames = catchup;
    if (fence) {
      for (const frame of catchup) fence.held.set(frame.seq, frame);
      frames = [...fence.held.values()].sort((a, b) => compareSeq(a.seq, b.seq));
      // Handlers queued behind this replay stay held for the next one.
      fence.waiting = fence.deferred;
      fence.deferred = new Set();
      if (fence.waiting.size === 0) subscription.fence = undefined;
    }
    for (const frame of frames) this.deliver(subscription, frame);

    const resend = subscription.resendQueued || Boolean(subscription.fence);
    subscription.resendQueued = false;
    return resend;
  }

  /** The replay will never arrive (thread error): release held frames. */
  abortReplay(threadId: string): void {
    const subscription = this.subscriptions.get(threadId);
    if (!subscription) return;
    subscription.replayInFlight = false;
    subscription.resendQueued = false;
    subscription.requestedAfter = undefined;
    const fence = subscription.fence;
    subscription.fence = undefined;
    if (!fence) return;
    for (const frame of [...fence.held.values()].sort((a, b) => compareSeq(a.seq, b.seq))) {
      this.deliver(subscription, frame);
    }
  }

  /** A gap: events before `toSeq` are unreplayable; every cursor jumps to it. */
  skipTo(subscription: ActiveThreadSubscription, toSeq: string): void {
    for (const handler of subscription.handlers) {
      subscription.cursors.set(handler, selectNewestSeq(subscription.cursors.get(handler), toSeq));
    }
    subscription.lastSeq = selectNewestSeq(subscription.lastSeq, toSeq);
  }

  /** The connection is gone: in-flight replays are void; the resume replays for everyone. */
  connectionLost(subscription: ActiveThreadSubscription): void {
    subscription.serverSubscribed = false;
    subscription.replayInFlight = false;
    subscription.resendQueued = false;
    subscription.requestedAfter = undefined;
    const fence = subscription.fence;
    if (fence) {
      for (const handler of fence.deferred) fence.waiting.add(handler);
      fence.deferred.clear();
    }
  }

  clearServerSubscribed(): void {
    for (const subscription of this.subscriptions.values()) this.connectionLost(subscription);
  }

  private deliver(subscription: ActiveThreadSubscription, frame: SequencedEvent): void {
    let delivered = false;
    for (const handler of subscription.handlers) {
      if (isHeld(subscription, handler)) continue;
      const cursor = subscription.cursors.get(handler);
      if (cursor !== undefined && compareSeq(frame.seq, cursor) <= 0) continue;
      subscription.cursors.set(handler, frame.seq);
      delivered = true;
      handler.onEvent(frame);
    }
    if (delivered) {
      subscription.lastSeq = selectNewestSeq(subscription.lastSeq, frame.seq);
      subscription.gapCount = 0;
    }
  }
}
