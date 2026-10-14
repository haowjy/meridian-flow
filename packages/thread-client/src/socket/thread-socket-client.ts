/**
 * ThreadSocketClient — the production `ThreadTransport` over `/api/threads/ws`.
 *
 * Owns the thread-domain control plane: per-thread subscribe/resume, gap
 * detection, and connection-state fan-out to subscribers. The socket lifecycle
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
  type ActiveThreadSubscription,
  oldestCursor,
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
    this.subscriptions.clearServerSubscribed();
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
    const { subscription, sendSubscribe, forceSubscribe, waiters } = this.subscriptions.ensure(
      threadId,
      handlers,
      opts?.after,
    );

    if (handlers.onConnectionState) {
      handlers.onConnectionState(this.socket.state);
    }

    this.ensureConnected();
    if (sendSubscribe && this.socket.isServerConnected()) {
      this.sendSubscribe(threadId, subscription, forceSubscribe, waiters);
    }

    return () => {
      const removed = this.subscriptions.removeHandler(threadId, handlers);
      if (!removed) return;
      if (this.socket.isSocketOpen() && removed.serverSubscribed) {
        this.send({ type: "unsubscribe", threadId });
      }
    };
  }

  respondInterrupt(input: InterruptRespondInput): InterruptRespondReceipt {
    const socketGeneration = this.socket.currentGeneration;
    const sent = this.send({ type: "interrupt.respond", ...input });
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
      this.send({ type: "catalog.subscribe", projectId });
    }
    return () => {
      const current = this.catalogSubscriptions.get(projectId);
      current?.delete(listener);
      if (current?.size) return;
      this.catalogSubscriptions.delete(projectId);
      if (this.socket.isServerConnected()) {
        this.send({ type: "catalog.unsubscribe", projectId });
      }
    };
  }

  cancel(threadId: string, turnId: string) {
    return this.options.cancelTurn(threadId, turnId);
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
      subscriptions: this.subscriptions,
      toError: this.options.toError,
      dispatchSequencedEvent: (threadId, seq, aguiEvent, error, sourceThreadId) =>
        this.dispatchSequencedEvent(threadId, seq, aguiEvent, error, sourceThreadId),
      handleGap: (gap) => this.handleGap(gap),
      resubscribe: (threadId) => {
        const subscription = this.subscriptions.get(threadId);
        if (subscription) this.sendSubscribe(threadId, subscription, true);
      },
      send: (payload) => this.send(payload),
      onConnected: () => {
        this.socket.markConnected();
        this.sendResume();
        for (const projectId of this.catalogSubscriptions.keys()) {
          this.send({ type: "catalog.subscribe", projectId });
        }
      },
      onThreadError: (threadId, error) => {
        const subscription = this.subscriptions.get(threadId);
        if (!subscription) return;
        this.subscriptions.abortReplay(threadId);
        for (const handler of subscription.handlers) {
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

  private sendResume(): void {
    if (!this.socket.isSocketOpen() || this.subscriptions.size === 0) return;
    // A reconnect replays for every handler, so every handler waits for it.
    for (const subscription of this.subscriptions.values()) {
      this.subscriptions.holdForReplay(subscription, subscription.handlers);
      subscription.replayInFlight = true;
      subscription.serverSubscribed = true;
    }
    this.send({
      type: "resume",
      subscriptions: Array.from(this.subscriptions.entries()).map(([threadId, subscription]) => ({
        threadId,
        lastSeq: oldestCursor(subscription) ?? "0",
      })),
    });
  }

  private sendSubscribe(
    threadId: string,
    subscription: ActiveThreadSubscription,
    force: boolean,
    waiters: Iterable<ThreadTransportHandlers> = [],
  ): void {
    if (!this.socket.isSocketOpen()) {
      subscription.serverSubscribed = false;
      return;
    }

    if (subscription.serverSubscribed && !force) {
      return;
    }

    this.subscriptions.holdForReplay(subscription, waiters);
    // One replay at a time: the server answers only the latest request, so a
    // second in-flight subscribe could leave the fence waiting forever.
    if (subscription.replayInFlight) {
      subscription.resendQueued = true;
      return;
    }

    subscription.replayInFlight = true;
    subscription.serverSubscribed = true;
    const lastSeq = oldestCursor(subscription);
    this.send({
      type: "subscribe",
      threadId,
      ...(lastSeq ? { lastSeq } : {}),
    });
  }

  private async handleGap(message: Extract<WsServerMessage, { type: "gap" }>): Promise<void> {
    const subscription = this.subscriptions.get(message.threadId);
    if (!subscription) {
      return;
    }

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

    // A gap means the server could not replay from our cursor. Jump the resume
    // point to the head it reported so the next subscribe requests events the
    // server can actually serve; re-requesting the same unreplayable window
    // would gap forever. The truncated history is recovered from the thread
    // snapshot the onGap consumers refetch.
    if (message.toSeq) {
      this.subscriptions.skipTo(subscription, message.toSeq);
    }

    // The gap answers the request in flight in place of a `subscribed`, so the
    // resubscribe below is the replay the fenced handlers now wait on.
    subscription.replayInFlight = false;
    if (this.socket.isSocketOpen()) {
      this.sendSubscribe(message.threadId, subscription, true);
    }
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
