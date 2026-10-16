/**
 * ThreadSocketClient — the production `ThreadTransport` over `/api/threads/ws`.
 *
 * Owns the thread-domain control plane: one `subscribe` request per thread
 * (named by `requestId`, ended by its `subscribed`, `gap`, error, deadline or
 * the connection's loss), per-thread retry, and connection-state fan-out. The socket lifecycle
 * (handshake readiness/deadline, connect/reconnect/backoff, ping-timeout,
 * generation tracking, terminal-close policy) lives in `SocketLifecycleController`;
 * message routing in `dispatch-ws-server-message`; subscription bookkeeping in
 * `ws-thread-subscription`. The single live agent-event transport.
 */
import {
  type AGUIEvent,
  type CancelTurnResponse,
  type MeridianError,
  parseWsServerMessage,
  type WsServerMessage,
} from "@meridian/contracts/protocol";

import { dispatchWsServerMessage } from "./dispatch-ws-server-message";
import { SocketLifecycleController, type SocketLifecycleOptions } from "./socket-lifecycle";
import type {
  ConnectionState,
  InterruptRespondInput,
  InterruptRespondReceipt,
  ThreadInterruptResponseError,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "./thread-transport";
import {
  computePersistentReconnectDelayMs,
  computeReconnectDelayMs,
  DEFAULT_WS_RECONNECT,
} from "./ws-reconnect";
import { DEFAULT_WS_REPLAY_DEADLINE_MS } from "./ws-thread-socket-utils";
import {
  clearRetryTimer,
  endRequest,
  oldestCursor,
  type ThreadSubscription,
  WsThreadSubscriptionRegistry,
} from "./ws-thread-subscription";

export type ThreadSocketClientOptions = SocketLifecycleOptions & {
  url: () => string;
  toError: (error: MeridianError) => Error;
  cancelTurn: (threadId: string, turnId: string) => Promise<CancelTurnResponse>;
};

export class ThreadSocketClient implements ThreadTransport {
  private readonly socket: SocketLifecycleController;
  private readonly subscriptions = new WsThreadSubscriptionRegistry();
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private readonly catalogSubscriptions = new Map<
    string,
    Set<(hint: Extract<WsServerMessage, { type: "context-catalog-hint" }>) => void>
  >();
  private readonly interruptResponseErrorListeners = new Set<
    (event: ThreadInterruptResponseError) => void
  >();
  private readonly socketGenerationClosedListeners = new Set<(generation: number) => void>();
  private wantsConnection = false;
  private requestCounter = 0;

  constructor(private readonly options: ThreadSocketClientOptions) {
    this.socket = new SocketLifecycleController(
      {
        buildUrl: options.url,
        wantsConnection: () => this.wantsConnection,
        onMessage: (data) => this.handleMessage(data),
        onClose: (event) => {
          // The generation that just closed is still `currentGeneration` here
          // (it only advances on the next `startSocket`/`teardown`), so a send
          // tagged with it can be recognized as unconfirmed.
          const closedGeneration = this.socket.currentGeneration;
          for (const listener of this.socketGenerationClosedListeners) {
            listener(closedGeneration);
          }
          for (const subscription of this.subscriptions.values()) {
            this.subscriptions.connectionLost(subscription);
            for (const handler of subscription.handlers) {
              handler.onClose?.(event);
            }
          }
        },
        onSocketError: () => this.publishError(new Error("WebSocket error")),
        publishConnectionState: (state) => this.publishConnectionState(state),
        publishError: (error) => this.publishError(error),
      },
      options,
    );
  }

  connect(): void {
    this.wantsConnection = true;
    this.socket.ensureConnected();
  }

  disconnect(_reason?: "logout" | "app_unmount"): void {
    this.wantsConnection = false;
    this.socket.teardown();
    for (const subscription of this.subscriptions.values()) {
      this.subscriptions.connectionLost(subscription);
    }
  }

  reconnect(): void {
    if (this.socket.state.kind === "terminal") return;
    this.wantsConnection = true;
    this.socket.reconnectNow();
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.socket.state);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  subscribe(
    threadId: string,
    handlers: ThreadTransportHandlers,
    opts?: ThreadTransportSubscribeOptions,
  ): () => void {
    const connected = this.socket.isServerConnected();
    const { subscription, sendRequest } = this.subscriptions.join(
      threadId,
      handlers,
      opts?.after,
      connected,
    );

    if (handlers.onConnectionState) {
      handlers.onConnectionState(this.socket.state);
    }

    this.ensureConnected();
    if (sendRequest && connected) this.sendRequest(threadId, subscription);

    return () => {
      const removed = this.subscriptions.remove(threadId, handlers);
      if (removed && this.socket.isSocketOpen()) {
        // Whether or not a lease is active: a pending request's lease must be disposed too.
        this.send({ type: "unsubscribe", requestId: this.nextRequestId(), threadId });
      }
    };
  }

  respondInterrupt(input: InterruptRespondInput): InterruptRespondReceipt {
    const socketGeneration = this.socket.currentGeneration;
    const sent = this.send({
      type: "interrupt.respond",
      requestId: this.nextRequestId(),
      ...input,
    });
    return sent ? { sent: true, socketGeneration } : { sent: false };
  }

  onInterruptResponseError(listener: (event: ThreadInterruptResponseError) => void): () => void {
    this.interruptResponseErrorListeners.add(listener);
    return () => {
      this.interruptResponseErrorListeners.delete(listener);
    };
  }

  onSocketGenerationClosed(listener: (generation: number) => void): () => void {
    this.socketGenerationClosedListeners.add(listener);
    return () => {
      this.socketGenerationClosedListeners.delete(listener);
    };
  }

  subscribeCatalog(
    projectId: string,
    listener: (hint: Extract<WsServerMessage, { type: "context-catalog-hint" }>) => void,
  ): () => void {
    const listeners = this.catalogSubscriptions.get(projectId) ?? new Set();
    const first = listeners.size === 0;
    listeners.add(listener);
    this.catalogSubscriptions.set(projectId, listeners);
    this.ensureConnected();
    if (first && this.socket.isServerConnected()) {
      this.send({ type: "catalog.subscribe", requestId: this.nextRequestId(), projectId });
    }
    return () => {
      const current = this.catalogSubscriptions.get(projectId);
      current?.delete(listener);
      if (current?.size) return;
      this.catalogSubscriptions.delete(projectId);
      if (this.socket.isServerConnected()) {
        this.send({ type: "catalog.unsubscribe", requestId: this.nextRequestId(), projectId });
      }
    };
  }

  cancel(threadId: string, turnId: string) {
    return this.options.cancelTurn(threadId, turnId);
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `r${this.requestCounter}`;
  }

  private ensureConnected(): void {
    this.wantsConnection = true;
    this.socket.ensureConnected();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;

    const message = parseWsServerMessage(data);
    if (!message) return;
    if (message.type === "context-catalog-hint") {
      const projectId = message.scope.kind === "user" ? null : message.scope.projectId;
      const targets = projectId
        ? this.catalogSubscriptions.get(projectId)
        : [...this.catalogSubscriptions.values()].flatMap((listeners) => [...listeners]);
      if (targets) for (const listener of targets) listener(message);
      return;
    }

    dispatchWsServerMessage(message, {
      toError: this.options.toError,
      dispatchSequencedEvent: (threadId, seq, aguiEvent, error, sourceThreadId) =>
        this.dispatchSequencedEvent(threadId, seq, aguiEvent, error, sourceThreadId),
      onSubscribed: (subscribed) => this.handleSubscribed(subscribed),
      handleGap: (gap) => this.handleGap(gap),
      send: (payload) => this.send(payload),
      onConnected: () => {
        this.socket.markConnected();
        // A reconnect replays for every handler, one request per thread.
        for (const [threadId, subscription] of this.subscriptions.entries()) {
          subscription.waiting = new Set(subscription.handlers);
          this.sendRequest(threadId, subscription);
        }
        for (const projectId of this.catalogSubscriptions.keys()) {
          this.send({ type: "catalog.subscribe", requestId: this.nextRequestId(), projectId });
        }
      },
      onRequestError: (requestId, error, retryable) =>
        this.handleRequestError(requestId, error, retryable),
      onThreadError: (threadId, error) => {
        for (const handler of this.subscriptions.get(threadId)?.handlers ?? []) {
          handler.onError?.(error);
        }
      },
      onInterruptResponseError: (threadId, error) => {
        for (const listener of this.interruptResponseErrorListeners) {
          listener({ threadId, error });
        }
      },
      onGlobalError: (error) => this.publishError(error),
    });
  }

  /** Sends a `subscribe` from the oldest cursor; it supersedes any request in flight. */
  private sendRequest(threadId: string, subscription: ThreadSubscription): void {
    const previous = subscription.request;
    if (previous) subscription.superseded.add(previous.id);
    endRequest(subscription);
    clearRetryTimer(subscription);

    const id = this.nextRequestId();
    const after = oldestCursor(subscription);
    subscription.request = {
      id,
      after,
      deadline: setTimeout(
        () => this.failRequest(threadId, subscription, id, new Error("Thread replay timed out")),
        DEFAULT_WS_REPLAY_DEADLINE_MS,
      ),
    };
    this.send({ type: "subscribe", requestId: id, threadId, ...(after ? { lastSeq: after } : {}) });
  }

  private handleSubscribed(message: Extract<WsServerMessage, { type: "subscribed" }>): void {
    const subscription = this.subscriptions.get(message.threadId);
    if (!subscription) return;
    const catchup = message.catchup.map((next) => ({
      seq: next.seq,
      event: next.event,
      error: next.error,
      sourceThreadId: next.sourceThreadId ?? message.threadId,
    }));
    if (subscription.request?.id === message.requestId) {
      this.subscriptions.settle(subscription, message.after, catchup);
      // After catch-up: a replayed frame is frozen at emit time, so the
      // server-computed live state wins over any stale replayed value.
      for (const handler of subscription.handlers) handler.onLiveState?.(message.state);
    } else if (subscription.superseded.delete(message.requestId)) {
      this.subscriptions.applySuperseded(subscription, catchup);
    }
  }

  /** A correlated error ends the request it names; any other id (a catalog request, a retired one) ends nothing. */
  private handleRequestError(requestId: string, error: Error, retryable: boolean): void {
    const found = this.subscriptions.findRequest(requestId);
    if (!found) return;
    const [threadId, subscription] = found;
    if (retryable) {
      this.failRequest(threadId, subscription, requestId, error);
      return;
    }
    // Refused: an old lease that survived a failed auth must not stream into `held` without end.
    this.subscriptions.voidLease(subscription);
    if (this.socket.isSocketOpen()) {
      this.send({ type: "unsubscribe", requestId: this.nextRequestId(), threadId });
    }
    for (const handler of subscription.handlers) handler.onError?.(error);
  }

  /** A request failed (retryable error or deadline): its thread retries alone, at its own backoff. */
  private failRequest(
    threadId: string,
    subscription: ThreadSubscription,
    requestId: string,
    error: Error,
  ): void {
    if (subscription.request?.id !== requestId) return;
    this.subscriptions.voidLease(subscription);
    // Handlers hear a failure once per episode.
    if (subscription.retry.attempt === 0) {
      for (const handler of subscription.handlers) handler.onError?.(error);
    }
    subscription.retry.attempt += 1;
    const attempt = subscription.retry.attempt;
    const delayMs =
      attempt <= DEFAULT_WS_RECONNECT.maxReconnectAttempts
        ? computeReconnectDelayMs(DEFAULT_WS_RECONNECT, attempt, Math.random)
        : computePersistentReconnectDelayMs(DEFAULT_WS_RECONNECT, Math.random);
    subscription.retry.timer = setTimeout(() => {
      subscription.retry.timer = undefined;
      if (this.socket.isServerConnected() && !subscription.request) {
        this.sendRequest(threadId, subscription);
      }
    }, delayMs);
  }

  private handleGap(message: Extract<WsServerMessage, { type: "gap" }>): void {
    const subscription = this.subscriptions.get(message.threadId);
    // A gap answers the request in flight in place of a `subscribed`.
    if (!subscription || subscription.request?.id !== message.requestId) return;

    subscription.gapCount += 1;
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

    // The server could not replay from our cursor. Jump to the head it
    // reported so the next request asks for events it can serve; the truncated
    // history is recovered from the thread snapshot the onGap consumers refetch.
    this.subscriptions.voidLease(subscription);
    if (message.toSeq) this.subscriptions.skipTo(subscription, message.toSeq);
    // The server answered, so no backoff.
    if (this.socket.isServerConnected()) this.sendRequest(message.threadId, subscription);
  }

  private send(payload: unknown): boolean {
    return this.socket.send(JSON.stringify(payload));
  }

  private dispatchSequencedEvent(
    threadId: string,
    seq: string,
    event: AGUIEvent,
    error?: MeridianError,
    sourceThreadId?: string,
  ): void {
    this.subscriptions.accept(threadId, {
      seq,
      event,
      error,
      sourceThreadId: sourceThreadId ?? threadId,
    });
  }

  private publishConnectionState(state: ConnectionState): void {
    for (const listener of this.connectionListeners) {
      listener(state);
    }
    for (const subscription of this.subscriptions.values()) {
      for (const handler of subscription.handlers) {
        handler.onConnectionState?.(state);
      }
    }
  }

  private publishError(error: Error): void {
    for (const subscription of this.subscriptions.values()) {
      for (const handler of subscription.handlers) {
        handler.onError?.(error);
      }
    }
  }
}
