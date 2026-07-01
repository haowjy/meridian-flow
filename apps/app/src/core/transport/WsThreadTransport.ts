/**
 * WsThreadTransport — the production `ThreadTransport` over `/api/threads/ws`.
 *
 * Owns the thread-domain control plane: per-thread subscribe/resume, gap
 * detection, server-"connected" gating, and connection-state fan-out to
 * subscribers. The socket lifecycle (connect/reconnect/backoff, ping-timeout,
 * generation tracking, terminal-close policy) lives in `SocketLifecycleController`;
 * message routing in `dispatch-ws-server-message`; subscription bookkeeping in
 * `ws-thread-subscription`. The single live agent-event transport.
 */
import {
  type AGUIEvent,
  compareSeq,
  type MeridianError,
  parseWsServerMessage,
  type SequencedEvent,
  type WsServerMessage,
} from "@meridian/contracts/protocol";
import { cancelTurn } from "@/client/api/threads-api";
import { buildThreadsWsUrl } from "./dev-transport";

import { dispatchWsServerMessage } from "./dispatch-ws-server-message";
import { SocketLifecycleController, type SocketLifecycleOptions } from "./socket-lifecycle";
import type {
  ConnectionState,
  InterruptRespondInput,
  ThreadTransport,
  ThreadTransportHandlers,
  ThreadTransportSubscribeOptions,
} from "./ThreadTransport";
import {
  type ActiveThreadSubscription,
  WsThreadSubscriptionRegistry,
} from "./ws-thread-subscription";

type WsThreadTransportOptions = SocketLifecycleOptions;

export class WsThreadTransport implements ThreadTransport {
  private readonly socket: SocketLifecycleController;
  private connectionState: ConnectionState = { kind: "disconnected" };
  private readonly subscriptions = new WsThreadSubscriptionRegistry();
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>();
  private wantsConnection = false;
  private serverConnected = false;
  private connectionToken: string | undefined;

  constructor(options: WsThreadTransportOptions = {}) {
    this.socket = new SocketLifecycleController(
      {
        buildUrl: () => buildThreadsWsUrl(),
        wantsConnection: () => this.wantsConnection,
        onOpen: () => {
          this.serverConnected = false;
          this.connectionToken = undefined;
        },
        onMessage: (data) => this.handleMessage(data),
        onClose: (event) => {
          this.serverConnected = false;
          this.connectionToken = undefined;
          for (const subscription of this.subscriptions.values()) {
            subscription.serverSubscribed = false;
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
    this.serverConnected = false;
    this.connectionToken = undefined;
    this.socket.teardown();
    this.subscriptions.clearServerSubscribed();
  }

  reconnect(): void {
    if (this.connectionState.kind === "terminal") return;
    this.wantsConnection = true;
    this.socket.reconnectNow();
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  subscribe(
    threadId: string,
    handlers: ThreadTransportHandlers,
    opts?: ThreadTransportSubscribeOptions,
  ): () => void {
    const { subscription, sendSubscribe, forceSubscribe } = this.subscriptions.ensure(
      threadId,
      handlers,
      opts?.after,
    );

    if (handlers.onConnectionState) {
      handlers.onConnectionState(this.connectionState);
    }

    this.ensureConnected();
    if (sendSubscribe && this.socket.isSocketOpen() && this.serverConnected) {
      this.sendSubscribe(threadId, subscription, forceSubscribe);
    }

    return () => {
      const removed = this.subscriptions.removeHandler(threadId, handlers);
      if (!removed) return;
      if (this.socket.isSocketOpen() && removed.serverSubscribed) {
        this.send({ type: "unsubscribe", threadId });
      }
    };
  }

  respondInterrupt(input: InterruptRespondInput): void {
    this.send({ type: "interrupt.respond", ...input });
  }

  cancel(threadId: string, turnId: string) {
    return cancelTurn({ data: { threadId, turnId } });
  }

  getConnectionToken(): string | undefined {
    return this.connectionToken;
  }

  awaitConnectionToken(): Promise<string> {
    const existing = this.connectionToken;
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timeoutMs = 30_000;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for WebSocket connection token"));
      }, timeoutMs);

      const onState = (state: ConnectionState) => {
        const token = this.connectionToken;
        if (token && state.kind === "connected") {
          cleanup();
          resolve(token);
          return;
        }
        if (state.kind === "terminal") {
          cleanup();
          reject(new Error(state.reason || "WebSocket connection failed"));
        }
      };

      const removeListener = this.onConnectionState(onState);
      this.ensureConnected();

      const cleanup = () => {
        clearTimeout(timer);
        removeListener();
      };

      const token = this.connectionToken;
      if (token && this.serverConnected) {
        cleanup();
        resolve(token);
      }
    });
  }

  private ensureConnected(): void {
    this.wantsConnection = true;
    this.socket.ensureConnected();
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== "string") return;

    const message = parseWsServerMessage(data);
    if (!message) return;

    dispatchWsServerMessage(message, {
      subscriptions: this.subscriptions,
      dispatchSequencedEvent: (threadId, seq, aguiEvent, error, sourceThreadId) =>
        this.dispatchSequencedEvent(threadId, seq, aguiEvent, error, sourceThreadId),
      handleGap: (gap) => this.handleGap(gap),
      send: (payload) => this.send(payload),
      onConnected: (connectionToken) => {
        this.connectionToken = connectionToken;
        this.socket.resetBackoff();
        this.serverConnected = true;
        this.publishConnectionState({ kind: "connected" });
        this.sendResume();
      },
      onThreadError: (threadId, error) => {
        const subscription = this.subscriptions.get(threadId);
        if (!subscription) return;
        for (const handler of subscription.handlers) {
          handler.onError?.(error);
        }
      },
      onGlobalError: (error) => this.publishError(error),
    });
  }

  private sendResume(): void {
    if (!this.socket.isSocketOpen() || this.subscriptions.size === 0) return;
    this.send({
      type: "resume",
      subscriptions: Array.from(this.subscriptions.entries()).map(([threadId, subscription]) => ({
        threadId,
        lastSeq: subscription.lastSeq ?? "0",
      })),
    });
  }

  private sendSubscribe(
    threadId: string,
    subscription: ActiveThreadSubscription,
    force: boolean,
  ): void {
    if (!this.socket.isSocketOpen()) {
      subscription.serverSubscribed = false;
      return;
    }

    if (subscription.serverSubscribed && !force) {
      return;
    }

    this.send({
      type: "subscribe",
      threadId,
      ...(subscription.lastSeq ? { lastSeq: subscription.lastSeq } : {}),
    });
    subscription.serverSubscribed = true;
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

    if (this.socket.isSocketOpen()) {
      this.sendSubscribe(message.threadId, subscription, true);
    }
  }

  private send(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
  }

  private dispatchSequencedEvent(
    threadId: string,
    seq: string,
    event: AGUIEvent,
    error?: MeridianError,
    sourceThreadId?: string,
  ): void {
    const subscription = this.subscriptions.get(threadId);
    if (!subscription) return;

    const lastSeq = subscription.lastSeq;
    if (lastSeq && compareSeq(seq, lastSeq) <= 0) {
      return;
    }

    subscription.lastSeq = seq;
    subscription.gapCount = 0;

    const payload: SequencedEvent = {
      seq,
      event,
      error,
      sourceThreadId: sourceThreadId ?? threadId,
    };

    for (const handler of subscription.handlers) {
      handler.onEvent(payload);
    }
  }

  private publishConnectionState(state: ConnectionState): void {
    this.connectionState = state;
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
