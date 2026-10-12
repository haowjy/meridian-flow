/** Owns thread handshake phases, reconnects, and current-generation callbacks. */

import { DEBUG_FEATURE_ALLOWED } from "../debug-gate";
import type { ConnectivityHintsPort } from "./connectivity-hints";
import type { ConnectionState } from "./ThreadTransport";
import { notifyThreadFrame, notifyThreadSocketClose, notifyThreadSocketOpen } from "./wire-tap";
import {
  computePersistentReconnectDelayMs,
  computeReconnectDelayMs,
  DEFAULT_WS_RECONNECT,
} from "./ws-reconnect";
import {
  DEFAULT_WS_PING_TIMEOUT_MS,
  formatWsCloseReason,
  isTerminalWsClose,
} from "./ws-thread-socket-utils";

export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 10_000;

type SocketPhase = "idle" | "connecting" | "awaiting-connected" | "connected";

export type SocketLifecycleOptions = {
  handshakeTimeoutMs?: number;
  connectivityHints?: ConnectivityHintsPort;
  webSocketFactory?: (url: string) => WebSocket;
};

/**
 * Domain callbacks the controller drives. Each is scoped to the socket that is
 * still current; stale-generation events are filtered out before dispatch.
 */
export type SocketLifecycleConsumer = {
  /** Same-origin (or threads) WS URL for the next socket. */
  buildUrl: () => string;
  /** True while the consumer still wants the socket up (drives reconnect). */
  wantsConnection: () => boolean;
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
  private readonly consumer: SocketLifecycleConsumer;
  private readonly handshakeTimeoutMs: number;

  private readonly connectivityHints?: ConnectivityHintsPort;
  private stopHints: (() => void) | null = null;

  private socket: WebSocket | null = null;
  private socketGeneration = 0;
  private phase: SocketPhase = "idle";
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionState: ConnectionState = { kind: "disconnected" };

  constructor(consumer: SocketLifecycleConsumer, options: SocketLifecycleOptions = {}) {
    this.consumer = consumer;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
    this.connectivityHints = options.connectivityHints;
    this.webSocketFactory = options.webSocketFactory ?? ((url) => new WebSocket(url));
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get currentGeneration(): number {
    return this.socketGeneration;
  }

  isSocketOpen(): boolean {
    return (
      (this.phase === "awaiting-connected" || this.phase === "connected") &&
      this.socket?.readyState === WebSocket.OPEN
    );
  }

  isSocketLive(): boolean {
    return (
      this.phase !== "idle" &&
      !!this.socket &&
      (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
    );
  }

  isServerConnected(): boolean {
    return this.phase === "connected" && this.isSocketOpen();
  }

  /** Complete the current protocol handshake after a parsed `connected` frame. */
  markConnected(): void {
    if (!this.isSocketOpen()) return;
    this.phase = "connected";
    this.clearHandshakeTimer();
    this.resetBackoff();
    this.publishConnectionState({ kind: "connected" });
  }

  private resetBackoff(): void {
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
    this.clearHandshakeTimer();
    this.phase = "idle";
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
    this.pingTimer = setTimeout(() => {
      this.pingTimer = null;
      this.closeCurrentSocket("ping_timeout");
    }, DEFAULT_WS_PING_TIMEOUT_MS);
  }

  private publishConnectionState(state: ConnectionState): void {
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
    this.clearHandshakeTimer();
    this.clearPingTimer();

    const generation = this.socketGeneration + 1;
    this.socketGeneration = generation;

    const attempt = Math.max(1, this.reconnectAttempt + 1);
    this.publishConnectionState({ kind: "connecting", attempt });

    const socket = this.webSocketFactory(this.consumer.buildUrl());
    this.socket = socket;
    this.phase = "connecting";
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      if (!this.isCurrentSocket(generation, socket)) return;
      this.closeCurrentSocket("handshake_timeout");
    }, this.handshakeTimeoutMs);

    socket.addEventListener("open", () => {
      if (!this.isCurrentSocket(generation, socket)) return;
      this.phase = "awaiting-connected";
      if (DEBUG_FEATURE_ALLOWED) notifyThreadSocketOpen(generation);
      this.resetPingTimer();
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
    // Retire before native close: an incomplete upgrade may never acknowledge it.
    this.handleSocketClose({ code: 4000, reason, wasClean: false } as CloseEvent);
    try {
      socket.close(4000, reason);
    } catch {
      // Some adapters cannot close an upgrade that has not completed.
    }
  }

  private handleSocketClose(event: CloseEvent): void {
    this.socket = null;
    this.phase = "idle";
    this.clearHandshakeTimer();
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

    const isAggressive = nextAttempt <= DEFAULT_WS_RECONNECT.maxReconnectAttempts;
    const delayMs = isAggressive
      ? computeReconnectDelayMs(DEFAULT_WS_RECONNECT, nextAttempt, Math.random)
      : computePersistentReconnectDelayMs(DEFAULT_WS_RECONNECT, Math.random);
    const nextRetryAt = Date.now() + delayMs;
    this.publishConnectionState(
      isAggressive
        ? { kind: "reconnecting", attempt: nextAttempt, nextRetryAt }
        : { kind: "degraded", attempt: nextAttempt, nextRetryAt },
    );
    if (!isAggressive) {
      this.consumer.publishError?.(error);
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.consumer.wantsConnection()) return;
      this.startSocket();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearHandshakeTimer(): void {
    if (!this.handshakeTimer) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  private clearPingTimer(): void {
    if (!this.pingTimer) return;
    clearTimeout(this.pingTimer);
    this.pingTimer = null;
  }

  private isCurrentSocket(generation: number, socket: WebSocket): boolean {
    return this.socketGeneration === generation && this.socket === socket;
  }
}
