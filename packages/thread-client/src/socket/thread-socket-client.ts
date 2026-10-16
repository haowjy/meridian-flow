/**
 * ThreadSocketClient — the production `ThreadTransport` over `/api/threads/ws`.
 *
 * Routes thread-domain messages and connection notifications. Per-thread
 * replay requests, outcomes, retries and delivery belong to the subscription registry.
 * `SocketLifecycleController` owns handshake readiness, reconnect, ping timeout
 * and generation fencing; `dispatch-ws-server-message` owns message routing.
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
import { WsThreadSubscriptionRegistry } from "./ws-thread-subscription";

export type ThreadSocketClientOptions = SocketLifecycleOptions & {
  url: () => string;
  toError: (error: MeridianError) => Error;
  cancelTurn: (threadId: string, turnId: string) => Promise<CancelTurnResponse>;
};

export class ThreadSocketClient implements ThreadTransport {
  private readonly socket: SocketLifecycleController;
  private readonly subscriptions = new WsThreadSubscriptionRegistry({
    isConnected: () => this.socket.isServerConnected(),
    nextRequestId: () => this.nextRequestId(),
    send: (message) => this.send(message),
  });
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
          this.subscriptions.connectionLost();
          for (const handler of this.subscriptions.handlers()) handler.onClose?.(event);
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
    this.subscriptions.connectionLost();
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
    this.subscriptions.join(threadId, handlers, opts?.after);
    handlers.onConnectionState?.(this.socket.state);
    this.ensureConnected();
    return () => this.subscriptions.remove(threadId, handlers);
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
      onSubscribed: (subscribed) => this.subscriptions.handleSubscribed(subscribed),
      handleGap: (gap) => this.subscriptions.handleGap(gap),
      send: (payload) => this.send(payload),
      onConnected: () => {
        this.socket.markConnected();
        this.subscriptions.connected();
        for (const projectId of this.catalogSubscriptions.keys()) {
          this.send({ type: "catalog.subscribe", requestId: this.nextRequestId(), projectId });
        }
      },
      onRequestError: (requestId, error, retryable) =>
        this.subscriptions.handleRequestError(requestId, error, retryable),
      onThreadError: (threadId, error) => {
        for (const handler of this.subscriptions.handlers(threadId)) {
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
    for (const handler of this.subscriptions.handlers()) handler.onConnectionState?.(state);
  }

  private publishError(error: Error): void {
    for (const handler of this.subscriptions.handlers()) handler.onError?.(error);
  }
}
