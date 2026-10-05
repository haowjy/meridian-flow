/** Manages WebSocket reconnects and current-generation callbacks. */

import { DEBUG_FEATURE_ALLOWED } from "../debug-gate";
import type { ConnectivityHintsPort } from "./connectivity-hints";
import type { ConnectionState } from "./ThreadTransport";
import { notifyThreadFrame, notifyThreadSocketClose, notifyThreadSocketOpen } from "./wire-tap";
import {
  computePersistentReconnectDelayMs,
  computeReconnectDelayMs,
  resolveWsReconnectBackoff,
  type WsReconnectBackoffConfig,
} from "./ws-reconnect";
import {
  DEFAULT_WS_PING_TIMEOUT_MS,
  formatWsCloseReason,
  isTerminalWsClose,
} from "./ws-thread-socket-utils";

export type SocketLifecycleOptions = {
  connectivityHints?: ConnectivityHintsPort;
  webSocketFactory?: (url: string) => WebSocket;
  backoff?: WsReconnectBackoffConfig;
  now?: () => number;
  random?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  pingTimeoutMs?: number;
};

/**
 * Domain callbacks the controller drives. Each is scoped to the socket that is
 * still current; stale-generation events are filtered out before dispatch.
 */
export type SocketLifecycleConsumer = {
  /** Same-origin (or threads) WS URL for the next socket. */
  buildUrl: () => string;
  /** Optional binaryType to set on the freshly created socket. */
  binaryType?: BinaryType;
  /** True while the consumer still wants the socket up (drives reconnect). */
  wantsConnection: () => boolean;
  /** Socket just opened. Ping timer is already armed. */
  onOpen: () => void;
  /** Inbound frame (string control or binary). */
  onMessage: (data: unknown) => void;
  /** Socket closed for a non-terminal reason; reconnect is being scheduled. */
  onClose?: (event: CloseEvent) => void;
  /** Transient socket "error" event (distinct from a close). */
  onSocketError?: () => void;
  /** Publish a connection state to the consumer's registry/listeners. */
  publishConnectionState: (state: ConnectionState) => void;
  /** Optional error fan-out (terminal close + exhausted budget). */
  publishError?: (error: Error) => void;
};

export class SocketLifecycleController {
  private readonly webSocketFactory: (url: string) => WebSocket;
  private readonly backoff: Required<WsReconnectBackoffConfig>;
  private readonly pingTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly consumer: SocketLifecycleConsumer;

  private readonly connectivityHints?: ConnectivityHintsPort;
  private stopHints: (() => void) | null = null;

  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionState: ConnectionState = { kind: "disconnected" };

  constructor(consumer: SocketLifecycleConsumer, options: SocketLifecycleOptions = {}) {
    this.consumer = consumer;
    this.connectivityHints = options.connectivityHints;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.backoff = resolveWsReconnectBackoff(options.backoff);
    this.pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_WS_PING_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.setTimeoutFn =
      options.setTimeoutFn ?? (globalThis.setTimeout.bind(globalThis) as typeof setTimeout);
    this.clearTimeoutFn =
      options.clearTimeoutFn ?? (globalThis.clearTimeout.bind(globalThis) as typeof clearTimeout);
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get currentSocket(): WebSocket | null {
    return this.socket;
  }

  get currentGeneration(): number {
    return this.socketGeneration;
  }

  isSocketOpen(): boolean {
    return !!this.socket && this.socket.readyState === WebSocket.OPEN;
  }

  isSocketLive(): boolean {
    return (
      !!this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    );
  }

  /** Reset backoff to the aggressive phase (e.g. after a successful sync). */
  resetBackoff(): void {
    this.reconnectAttempt = 0;
  }

  /** Open a socket if one isn't already live. No-op after a terminal close. */
  ensureConnected(): void {
    if (this.connectionState.kind === "terminal") return;
    this.subscribeHints();
    if (this.isSocketLive()) return;
    this.startSocket();
  }

  /** Force immediate (re)connect, resetting backoff. No-op after terminal. */
  reconnectNow(): void {
    if (this.connectionState.kind === "terminal") return;
    this.subscribeHints();
    this.clearReconnectTimer();
    this.clearPingTimer();
    if (this.isSocketLive()) this.closeCurrentSocket("manual_reconnect");
    this.resetBackoff();
    this.startSocket();
  }

  /** Tear down the socket and timers; publishes `disconnected`. */
  teardown(): void {
    this.stopHints?.();
    this.stopHints = null;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.reconnectAttempt = 0;
    const socket = this.socket;
    this.socket = null;
    this.socketGeneration += 1;
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore close failures during teardown
      }
    }
    this.publishConnectionState({ kind: "disconnected" });
  }

  /** Write one frame to the current socket. */
  send(data: string | ArrayBufferLike | ArrayBufferView): boolean {
    if (!this.isSocketOpen()) return false;
    const socket = this.socket;
    if (!socket) return false;
    if (DEBUG_FEATURE_ALLOWED && typeof data === "string") {
      notifyThreadFrame("client_to_server", data, this.socketGeneration);
    }
    try {
      socket.send(data as Parameters<WebSocket["send"]>[0]);
      return true;
    } catch {
      return false;
    }
  }

  resetPingTimer(): void {
    this.clearPingTimer();
    this.pingTimer = this.setTimeoutFn(() => {
      this.pingTimer = null;
      this.socket?.close(4000, "ping_timeout");
    }, this.pingTimeoutMs);
  }

  publishConnectionState(state: ConnectionState): void {
    if (state.kind === "connected") this.connectivityHints?.reportConnected(this);
    else this.connectivityHints?.reportDisconnected(this);
    this.connectionState = state;
    this.consumer.publishConnectionState(state);
  }

  private subscribeHints(): void {
    if (this.stopHints) return;
    this.stopHints =
      this.connectivityHints?.subscribe(this, (hint) => {
        if (this.connectionState.kind === "terminal" || !this.consumer.wantsConnection()) return;
        if (hint === "suspect-offline") {
          this.closeCurrentSocket("browser_offline");
        } else if (!this.isSocketOpen()) {
          this.reconnectNow();
        }
      }) ?? null;
  }

  private startSocket(): void {
    if (this.connectionState.kind === "terminal") return;
    this.clearReconnectTimer();

    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;

    const attempt = Math.max(1, this.reconnectAttempt + 1);
    this.publishConnectionState({ kind: "connecting", attempt });

    const socket = this.webSocketFactory(this.consumer.buildUrl());
    if (this.consumer.binaryType) socket.binaryType = this.consumer.binaryType;
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(generation, socket)) return;
      if (DEBUG_FEATURE_ALLOWED) notifyThreadSocketOpen(generation);
      this.resetPingTimer();
      this.consumer.onOpen();
    });

    socket.addEventListener("message", (event) => {
      if (!this.isCurrentSocket(generation, socket)) return;
      const data = (event as MessageEvent).data;
      if (DEBUG_FEATURE_ALLOWED && typeof data === "string") {
        notifyThreadFrame("server_to_client", data, generation);
      }
      this.resetPingTimer();
      this.consumer.onMessage(data);
    });

    socket.addEventListener("error", () => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.consumer.onSocketError?.();
    });

    socket.addEventListener("close", (event) => {
      if (DEBUG_FEATURE_ALLOWED) {
        const closeEvent = event as CloseEvent;
        notifyThreadSocketClose(generation, closeEvent.code, closeEvent.wasClean);
      }
      if (!this.isCurrentSocket(generation, socket)) return;
      this.handleSocketClose(event as CloseEvent);
    });
  }

  private closeCurrentSocket(reason: string): void {
    const socket = this.socket;
    if (!socket) return;
    const generation = this.socketGeneration;
    socket.close(4000, reason);
    // Native close may await a handshake that an offline network cannot finish.
    if (this.isCurrentSocket(generation, socket)) {
      this.handleSocketClose({ code: 4000, reason, wasClean: false } as CloseEvent);
    }
  }

  private handleSocketClose(event: CloseEvent): void {
    this.socket = null;
    this.clearPingTimer();
    this.consumer.onClose?.(event);

    if (!this.consumer.wantsConnection()) {
      this.publishConnectionState({ kind: "disconnected" });
      return;
    }

    if (isTerminalWsClose(event)) {
      const reason = formatWsCloseReason(event);
      this.publishConnectionState({
        kind: "terminal",
        reason,
        code: event.code,
      });
      this.consumer.publishError?.(new Error(reason));
      return;
    }

    this.scheduleReconnect(new Error(formatWsCloseReason(event)));
  }

  private scheduleReconnect(error: Error): void {
    this.clearReconnectTimer();

    const nextAttempt = this.reconnectAttempt + 1;
    this.reconnectAttempt = nextAttempt;

    const isAggressive = nextAttempt <= this.backoff.maxReconnectAttempts;
    const delayMs = isAggressive
      ? computeReconnectDelayMs(this.backoff, nextAttempt, this.random)
      : computePersistentReconnectDelayMs(this.backoff, this.random);
    const nextRetryAt = this.now() + delayMs;
    this.publishConnectionState(
      isAggressive
        ? { kind: "reconnecting", attempt: nextAttempt, nextRetryAt }
        : { kind: "degraded", attempt: nextAttempt, nextRetryAt },
    );
    if (!isAggressive) {
      this.consumer.publishError?.(error);
    }

    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = null;
      if (!this.consumer.wantsConnection()) return;
      this.startSocket();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    this.clearTimeoutFn(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearPingTimer(): void {
    if (!this.pingTimer) return;
    this.clearTimeoutFn(this.pingTimer);
    this.pingTimer = null;
  }

  private isCurrentSocket(generation: number, socket: WebSocket): boolean {
    return this.socketGeneration === generation && this.socket === socket;
  }
}
