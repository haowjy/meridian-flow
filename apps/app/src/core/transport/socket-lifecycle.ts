/**
 * socket-lifecycle — the boring, shared WebSocket control plane for the WS
 * transports.
 *
 * Owns everything that is identical between `WsThreadTransport` and the
 * Hocuspocus-backed document transport: socket creation, generation/epoch tracking,
 * connect/reconnect with jittered backoff (via `ws-reconnect`), ping-timeout
 * liveness, terminal-close policy (via `isTerminalWsClose`), and connection-state
 * publication. The consumer owns only its domain: URL/binaryType, what to do on
 * open/message, whether it still wants a connection, and how to fan connection
 * state out to its own registry.
 *
 * Terminal closes (4401/4403) publish a `terminal` `ConnectionState` and STOP
 * retrying — the controller will refuse to (re)connect afterward. This is why
 * both transports get auth-close-as-terminal for free.
 */
import type { ConnectionState } from "./ThreadTransport";
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
  private readonly maxReconnectAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterRatio: number;
  private readonly persistentDelayMs: number;
  private readonly pingTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly consumer: SocketLifecycleConsumer;

  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionState: ConnectionState = { kind: "disconnected" };

  constructor(consumer: SocketLifecycleConsumer, options: SocketLifecycleOptions = {}) {
    this.consumer = consumer;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    const backoff = resolveWsReconnectBackoff(options.backoff);
    this.maxReconnectAttempts = backoff.maxReconnectAttempts;
    this.baseDelayMs = backoff.baseDelayMs;
    this.maxDelayMs = backoff.maxDelayMs;
    this.jitterRatio = backoff.jitterRatio;
    this.persistentDelayMs = backoff.persistentDelayMs;
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
    if (this.isSocketLive()) return;
    this.startSocket();
  }

  /** Force immediate (re)connect, resetting backoff. No-op after terminal. */
  reconnectNow(): void {
    if (this.connectionState.kind === "terminal") return;
    this.clearReconnectTimer();
    this.clearPingTimer();
    this.reconnectAttempt = 0;
    if (this.isSocketLive()) {
      this.socket?.close(4000, "manual_reconnect");
      return;
    }
    this.startSocket();
  }

  /** Tear down the socket and timers; publishes `disconnected`. */
  teardown(): void {
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

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (!this.isSocketOpen()) return;
    this.socket?.send(data as Parameters<WebSocket["send"]>[0]);
  }

  resetPingTimer(): void {
    this.clearPingTimer();
    this.pingTimer = this.setTimeoutFn(() => {
      this.pingTimer = null;
      this.socket?.close(4000, "ping_timeout");
    }, this.pingTimeoutMs);
  }

  publishConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.consumer.publishConnectionState(state);
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
      this.resetPingTimer();
      this.consumer.onOpen();
    });

    socket.addEventListener("message", (event) => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.resetPingTimer();
      this.consumer.onMessage((event as MessageEvent).data);
    });

    socket.addEventListener("error", () => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.consumer.onSocketError?.();
    });

    socket.addEventListener("close", (event) => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.socket = null;
      this.clearPingTimer();
      this.consumer.onClose?.(event as CloseEvent);

      if (!this.consumer.wantsConnection()) {
        this.publishConnectionState({ kind: "disconnected" });
        return;
      }

      if (isTerminalWsClose(event as CloseEvent)) {
        const reason = formatWsCloseReason(event as CloseEvent);
        this.publishConnectionState({
          kind: "terminal",
          reason,
          code: (event as CloseEvent).code,
        });
        this.consumer.publishError?.(new Error(reason));
        return;
      }

      this.scheduleReconnect(new Error(formatWsCloseReason(event as CloseEvent)));
    });
  }

  private scheduleReconnect(error: Error): void {
    this.clearReconnectTimer();

    const nextAttempt = this.reconnectAttempt + 1;
    this.reconnectAttempt = nextAttempt;

    const isAggressive = nextAttempt <= this.maxReconnectAttempts;
    const delayMs = isAggressive
      ? this.computeBackoffDelay(nextAttempt)
      : this.computePersistentDelay();
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

  private computeBackoffDelay(attempt: number): number {
    return computeReconnectDelayMs(this.backoffConfig(), attempt, this.random);
  }

  private computePersistentDelay(): number {
    return computePersistentReconnectDelayMs(this.backoffConfig(), this.random);
  }

  private backoffConfig() {
    return {
      maxReconnectAttempts: this.maxReconnectAttempts,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      jitterRatio: this.jitterRatio,
      persistentDelayMs: this.persistentDelayMs,
    };
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
