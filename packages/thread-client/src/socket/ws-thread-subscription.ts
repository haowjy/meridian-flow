/**
 * ws-thread-subscription — the per-thread subscription registry for
 * `ThreadSocketClient`.
 *
 * Owns subscription bookkeeping and the delivery contract: each handler
 * receives every sequenced event above its own cursor, exactly once and in
 * `seq` order, whatever the timing between live frames and a replay. A
 * subscription holds at most one request in flight; handlers that need a
 * replay are `waiting` and take live frames only through the catch-up the
 * request's `subscribed` brings. Owns request and retry transitions, including
 * their timers; the transport owns the socket.
 */
import {
  compareSeq,
  type SequencedEvent,
  type WsClientMessage,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import type { ThreadTransportHandlers } from "./thread-transport";
import {
  computePersistentReconnectDelayMs,
  computeReconnectDelayMs,
  DEFAULT_WS_RECONNECT,
} from "./ws-reconnect";
import { DEFAULT_WS_REPLAY_DEADLINE_MS } from "./ws-thread-socket-utils";

type Timer = ReturnType<typeof setTimeout>;

type ThreadSubscription = {
  handlers: Set<ThreadTransportHandlers>;
  /** Each handler's cursor: the last seq delivered, or the `after` it joined with; undefined = from the position, until one is known. */
  cursors: Map<ThreadTransportHandlers, string | undefined>;
  /** max(lease floor, highest delivered seq). Only rises. Undefined until the first `subscribed` or delivery. */
  position?: string;
  /** The client's belief that the server holds a lease for this thread: set by a matching `subscribed`, cleared by any failure or connection loss. */
  lease: "none" | "active";
  /** Handlers that need a replay before a live frame may reach them. */
  waiting: Set<ThreadTransportHandlers>;
  /** Frames held for `waiting` since the request in flight was sent: live frames, and a superseded request's catch-up. */
  held: Map<string, SequencedEvent>;
  /** The request owns older ids whose acknowledgements may still contribute frames until it ends. */
  request?: { id: string; after?: string; deadline: Timer; superseded: Set<string> };
  /** This thread's backoff for failed requests. Reset by `subscribed`, connection loss, and removal. */
  retry: { attempt: number; timer?: Timer };
  gapCount: number;
};

function selectNewestSeq(a?: string, b?: string): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return compareSeq(a, b) >= 0 ? a : b;
}

/** The lowest defined cursor: the wire cursor of a request. Undefined when no handler has one. */
function oldestCursor(subscription: ThreadSubscription): string | undefined {
  let oldest: string | undefined;
  for (const cursor of subscription.cursors.values()) {
    if (cursor !== undefined && (oldest === undefined || compareSeq(cursor, oldest) < 0)) {
      oldest = cursor;
    }
  }
  return oldest;
}

export class WsThreadSubscriptionRegistry {
  private readonly subscriptions = new Map<string, ThreadSubscription>();

  constructor(
    private readonly transport: {
      isConnected: () => boolean;
      nextRequestId: () => string;
      send: (message: WsClientMessage) => void;
    },
  ) {}

  /** Every send, including a deferred retry, must still belong to this registry. */
  private sendRequest(threadId: string, subscription: ThreadSubscription): void {
    if (
      this.get(threadId) !== subscription ||
      !subscription.handlers.size ||
      !this.transport.isConnected()
    )
      return;
    const previous = subscription.request;
    const superseded = previous?.superseded ?? new Set<string>();
    if (previous) superseded.add(previous.id);
    endRequest(subscription);
    clearRetryTimer(subscription);
    const id = this.transport.nextRequestId();
    const after = oldestCursor(subscription);
    subscription.request = {
      id,
      after,
      superseded,
      deadline: setTimeout(
        () => this.failRequest(threadId, subscription, id, new Error("Thread replay timed out")),
        DEFAULT_WS_REPLAY_DEADLINE_MS,
      ),
    };
    this.transport.send({
      type: "subscribe",
      requestId: id,
      threadId,
      ...(after ? { lastSeq: after } : {}),
    });
  }

  /** Complete the transition before callbacks: an onError unsubscribe must cancel this retry. */
  private failRequest(
    threadId: string,
    subscription: ThreadSubscription,
    requestId: string,
    error: Error,
  ): void {
    if (subscription.request?.id !== requestId) return;
    this.voidLease(subscription);
    const notify = subscription.retry.attempt === 0;
    const attempt = ++subscription.retry.attempt;
    const delayMs =
      attempt <= DEFAULT_WS_RECONNECT.maxReconnectAttempts
        ? computeReconnectDelayMs(DEFAULT_WS_RECONNECT, attempt, Math.random)
        : computePersistentReconnectDelayMs(DEFAULT_WS_RECONNECT, Math.random);
    subscription.retry.timer = setTimeout(() => {
      subscription.retry.timer = undefined;
      this.sendRequest(threadId, subscription);
    }, delayMs);
    if (notify) for (const handler of subscription.handlers) handler.onError?.(error);
  }

  handleGap(message: Extract<WsServerMessage, { type: "gap" }>): void {
    const subscription = this.get(message.threadId);
    if (!subscription || subscription.request?.id !== message.requestId) return;
    this.voidLease(subscription);
    if (message.toSeq) this.skipTo(subscription, message.toSeq);
    subscription.gapCount += 1;
    // Establish the replacement before callbacks, so removal cancels its deadline and lease.
    this.sendRequest(message.threadId, subscription);
    for (const handler of subscription.handlers) {
      handler.onGap?.({
        threadId: message.threadId,
        cause: message.cause,
        fromSeq: message.fromSeq,
        toSeq: message.toSeq,
        message: message.message,
        gapCount: subscription.gapCount,
      });
    }
  }

  handleSubscribed(message: Extract<WsServerMessage, { type: "subscribed" }>): void {
    const subscription = this.get(message.threadId);
    if (!subscription) return;
    const catchup = message.catchup.map((next) => ({
      seq: next.seq,
      event: next.event,
      error: next.error,
      sourceThreadId: next.sourceThreadId ?? message.threadId,
    }));
    if (subscription.request?.id === message.requestId) {
      this.settle(subscription, message.after, catchup);
      // After catch-up: a replayed frame is frozen at emit time, so the
      // server-computed live state wins over any stale replayed value.
      for (const handler of subscription.handlers) handler.onLiveState?.(message.state);
    } else if (subscription.request?.superseded.delete(message.requestId)) {
      this.applySuperseded(subscription, catchup);
    }
  }

  /** A correlated error ends the request it names; any other id (a catalog request, a retired one) ends nothing. */
  handleRequestError(requestId: string, error: Error, retryable: boolean): void {
    const found = this.findRequest(requestId);
    if (!found) return;
    const [threadId, subscription] = found;
    if (retryable) {
      this.failRequest(threadId, subscription, requestId, error);
      return;
    }
    // Refused: an old lease that survived a failed auth must not stream into `held` without end.
    this.voidLease(subscription);
    this.transport.send({
      type: "unsubscribe",
      requestId: this.transport.nextRequestId(),
      threadId,
    });
    for (const handler of subscription.handlers) handler.onError?.(error);
  }

  private get(threadId: string): ThreadSubscription | undefined {
    return this.subscriptions.get(threadId);
  }

  *handlers(threadId?: string): IterableIterator<ThreadTransportHandlers> {
    if (threadId !== undefined) {
      yield* this.get(threadId)?.handlers ?? [];
    } else {
      for (const subscription of this.subscriptions.values()) yield* subscription.handlers;
    }
  }

  connected(): void {
    for (const [threadId, subscription] of this.subscriptions)
      this.sendRequest(threadId, subscription);
  }

  connectionLost(): void {
    for (const subscription of this.subscriptions.values()) {
      this.voidLease(subscription);
      subscription.retry.attempt = 0;
    }
  }

  /** The subscription holding request `requestId` in flight, with its thread. */
  private findRequest(requestId: string): [string, ThreadSubscription] | undefined {
    for (const entry of this.subscriptions) if (entry[1].request?.id === requestId) return entry;
    return undefined;
  }

  /** A handler joins with cursor `after`, or none. See the join table in `.context/CONTEXT.md`. */
  join(threadId: string, handler: ThreadTransportHandlers, after: string | undefined): void {
    let subscription = this.subscriptions.get(threadId);
    if (!subscription) {
      subscription = {
        handlers: new Set([handler]),
        cursors: new Map([[handler, after]]),
        lease: "none",
        waiting: new Set([handler]),
        held: new Map(),
        retry: { attempt: 0 },
        gapCount: 0,
      };
      this.subscriptions.set(threadId, subscription);
      this.sendRequest(threadId, subscription);
      return;
    }

    const position = subscription.position;
    const requested = subscription.request?.after;
    const inFlight = Boolean(subscription.request);
    // A cursorless handler starts at the position, else at the replay in flight.
    subscription.handlers.add(handler);
    subscription.cursors.set(handler, after ?? position ?? (inFlight ? requested : undefined));

    if (!this.transport.isConnected()) {
      subscription.waiting.add(handler);
      return;
    }
    if (inFlight) {
      subscription.waiting.add(handler);
      const supersedes =
        after !== undefined && requested !== undefined && compareSeq(after, requested) < 0;
      if (supersedes) this.sendRequest(threadId, subscription);
      return;
    }
    if (subscription.lease === "active") {
      if (after === undefined || (position !== undefined && compareSeq(after, position) >= 0)) {
        return;
      }
      subscription.waiting = new Set([handler]);
      this.sendRequest(threadId, subscription);
      return;
    }
    // No lease and no request (refused, retrying, or not yet requested): everyone waits.
    subscription.waiting = new Set(subscription.handlers);
    this.sendRequest(threadId, subscription);
  }

  /** Last handler removal cancels both local recovery and the server lease. */
  remove(threadId: string, handler: ThreadTransportHandlers): void {
    const subscription = this.subscriptions.get(threadId);
    if (!subscription) return;

    subscription.handlers.delete(handler);
    subscription.cursors.delete(handler);
    subscription.waiting.delete(handler);
    if (subscription.handlers.size > 0) return;

    this.subscriptions.delete(threadId);
    endRequest(subscription);
    clearRetryTimer(subscription);
    this.transport.send({
      type: "unsubscribe",
      requestId: this.transport.nextRequestId(),
      threadId,
    });
  }

  /** A live frame: held for waiting handlers while a request is in flight, delivered now to the rest. */
  accept(threadId: string, frame: SequencedEvent): void {
    const subscription = this.subscriptions.get(threadId);
    if (!subscription) return;
    if (subscription.request) subscription.held.set(frame.seq, frame);
    this.deliver(subscription, frame);
  }

  /**
   * The `subscribed` frame of the request in flight: the lease is active from
   * `after`, and every waiting handler gets the catch-up merged with the held
   * live frames, in `seq` order, before `onLiveState`.
   */
  private settle(subscription: ThreadSubscription, after: string, catchup: SequencedEvent[]): void {
    subscription.lease = "active";
    subscription.position = selectNewestSeq(subscription.position, after);
    for (const handler of subscription.handlers) {
      if (subscription.cursors.get(handler) === undefined) {
        subscription.cursors.set(handler, after);
      }
    }
    endRequest(subscription);
    clearRetryTimer(subscription);
    subscription.retry.attempt = 0;
    for (const frame of catchup) subscription.held.set(frame.seq, frame);
    const frames = [...subscription.held.values()].sort((a, b) => compareSeq(a.seq, b.seq));
    subscription.held.clear();
    subscription.waiting.clear();
    subscription.gapCount = 0;
    for (const frame of frames) this.deliver(subscription, frame);
  }

  /**
   * A superseded request's `subscribed`: a batch of frames from a lease the
   * newer request will replace. Delivered to the handlers that are not waiting
   * (the socket's order puts it before that lease's live frames); it settles nothing.
   */
  private applySuperseded(subscription: ThreadSubscription, catchup: SequencedEvent[]): void {
    const frames = [...catchup].sort((a, b) => compareSeq(a.seq, b.seq));
    for (const frame of frames) {
      if (subscription.request) subscription.held.set(frame.seq, frame);
      this.deliver(subscription, frame);
    }
  }

  /** The lease is void (a failed request, a refusal, a gap): every handler waits for the next `subscribed`. */
  private voidLease(subscription: ThreadSubscription): void {
    endRequest(subscription);
    clearRetryTimer(subscription);
    subscription.held.clear();
    subscription.lease = "none";
    subscription.waiting = new Set(subscription.handlers);
  }

  /** A gap: events before `toSeq` are unreplayable; every cursor and the position jump to it. */
  private skipTo(subscription: ThreadSubscription, toSeq: string): void {
    for (const handler of subscription.handlers) {
      subscription.cursors.set(handler, selectNewestSeq(subscription.cursors.get(handler), toSeq));
    }
    subscription.position = selectNewestSeq(subscription.position, toSeq);
  }

  private deliver(subscription: ThreadSubscription, frame: SequencedEvent): void {
    let delivered = false;
    for (const handler of subscription.handlers) {
      if (subscription.waiting.has(handler)) continue;
      const cursor = subscription.cursors.get(handler);
      if (cursor !== undefined && compareSeq(frame.seq, cursor) <= 0) continue;
      subscription.cursors.set(handler, frame.seq);
      delivered = true;
      handler.onEvent(frame);
    }
    if (delivered) {
      subscription.position = selectNewestSeq(subscription.position, frame.seq);
      subscription.gapCount = 0;
    }
  }
}

/** Ends the request in flight and stops its deadline. */
function endRequest(subscription: ThreadSubscription): void {
  if (subscription.request) clearTimeout(subscription.request.deadline);
  subscription.request = undefined;
}

function clearRetryTimer(subscription: ThreadSubscription): void {
  if (subscription.retry.timer) clearTimeout(subscription.retry.timer);
  subscription.retry.timer = undefined;
}
