// ═══════════════════════════════════════════════════════════════════
// WsClient — shared WebSocket client base for all project WS connections.
//
// Handles: connection state machine, auth bootstrap, heartbeat pong,
// reconnection with exponential backoff + jitter, protocol envelope
// dispatch by kind, and useSyncExternalStore contract.
//
// Both DocWsProvider and ThreadWsProvider create a WsClient instance.
// Pattern follows DocumentWsProviderImpl (same reconnection params).
// ═══════════════════════════════════════════════════════════════════

import {
  type ConnectionState,
  type Envelope,
  CONTROL_OP,
  CONTROL_RESPONSE_OP,
  controlEnvelope,
  parseEnvelope,
} from "./protocol"

// ---------------------------------------------------------------------------
// Constants — match DocumentWsProviderImpl reconnection parameters
// ---------------------------------------------------------------------------

const RECONNECT_BASE_DELAY_MS = 250
const RECONNECT_MAX_DELAY_MS = 5_000
const RECONNECT_MIN_DELAY_MS = 100
const RECONNECT_JITTER_FACTOR = 0.15

const WS_OPEN = 1

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface WsClientConfig {
  /** Full WebSocket URL (wss://...) */
  url: string
  /** JWT provider — called on each connect/reconnect */
  getToken: () => Promise<string>
  /** Called for every `notify` lane message */
  onNotify?: (msg: Envelope) => void
  /** Called for every `stream` lane message */
  onStream?: (msg: Envelope) => void
  /** Called for every `control` lane message (after internal handling) */
  onControl?: (msg: Envelope) => void
  /** Called for every `error` lane message */
  onError?: (msg: Envelope) => void
  /** Called when connection state changes */
  onStateChange?: (state: ConnectionState) => void
  /**
   * Called when a binary frame arrives. The framework extracts the subId
   * routing prefix (<subId UTF-8> 0x00 <payload>) and delivers the subId
   * and remaining payload bytes.
   */
  onBinaryMessage?: (subId: string, data: Uint8Array) => void
}

// ---------------------------------------------------------------------------
// WsClient
// ---------------------------------------------------------------------------

/** Mutable subset of WsClientConfig — callbacks that can change over time. */
export type WsClientCallbacks = Partial<Omit<WsClientConfig, "url">>

/**
 * Shared WebSocket client with auth, heartbeat, reconnection,
 * and protocol envelope dispatch.
 *
 * Implements `subscribe`/`getSnapshot` for React's `useSyncExternalStore`.
 */
export class WsClient {
  private config: WsClientConfig
  private readonly subscribers = new Set<() => void>()

  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private destroyed = false
  private shouldReconnect = false
  private connectionState: ConnectionState = "disconnected"

  constructor(config: WsClientConfig) {
    this.config = config
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Start the connection. No-op if already connected or destroyed. */
  connect(): void {
    if (this.destroyed) return
    if (this.connectionState !== "disconnected") return

    this.shouldReconnect = true
    this.clearReconnectTimer()
    this.openSocket()
  }

  /** Cleanly close the connection. Prevents automatic reconnection. */
  disconnect(): void {
    this.shouldReconnect = false
    this.clearReconnectTimer()
    this.closeSocket()
    this.setConnectionState("disconnected")
  }

  /** Send a JSON envelope over the WS. Silently drops if not connected. */
  send(msg: Envelope): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return
    this.socket.send(JSON.stringify(msg))
  }

  /**
   * Send a binary frame with subId routing prefix.
   *
   * Frame format: <subId UTF-8> 0x00 <payload>
   * The server extracts the subId from the prefix and routes the
   * payload to the corresponding subscription handler.
   */
  sendBinary(subId: string, data: Uint8Array): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) return

    const encoder = new TextEncoder()
    const subIdBytes = encoder.encode(subId)
    const frame = new Uint8Array(subIdBytes.length + 1 + data.length)
    frame.set(subIdBytes, 0)
    frame[subIdBytes.length] = 0x00 // null byte delimiter
    frame.set(data, subIdBytes.length + 1)

    this.socket.send(frame)
  }

  /** Current connection state. */
  get state(): ConnectionState {
    return this.connectionState
  }

  /** Permanently tear down — disconnect + prevent any future use. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.disconnect()
    this.subscribers.clear()
  }

  /**
   * Update callbacks without reconnecting. React components call this
   * in useEffect to keep handlers fresh when prop/context identities
   * change, avoiding WS reconnection churn.
   */
  updateCallbacks(callbacks: WsClientCallbacks): void {
    this.config = { ...this.config, ...callbacks }
  }

  // -----------------------------------------------------------------------
  // useSyncExternalStore contract
  // -----------------------------------------------------------------------

  /**
   * Subscribe to connection state changes. Returns unsubscribe function.
   * Used by React's `useSyncExternalStore`.
   */
  subscribe = (callback: () => void): (() => void) => {
    this.subscribers.add(callback)
    return () => {
      this.subscribers.delete(callback)
    }
  }

  /**
   * Get the current connection state snapshot.
   * Used by React's `useSyncExternalStore`.
   */
  getSnapshot = (): ConnectionState => {
    return this.connectionState
  }

  // -----------------------------------------------------------------------
  // Connection internals
  // -----------------------------------------------------------------------

  private openSocket(): void {
    if (this.destroyed || !this.shouldReconnect) return
    if (this.socket !== null) return

    this.setConnectionState("connecting")

    const socket = new WebSocket(this.config.url)
    socket.binaryType = "arraybuffer"
    this.socket = socket
    this.attachSocketHandlers(socket)
  }

  private attachSocketHandlers(socket: WebSocket): void {
    socket.onopen = () => {
      void this.authenticateSocket(socket)
    }

    socket.onmessage = (event) => {
      if (this.destroyed || socket !== this.socket) return

      // Binary frame — extract subId routing prefix and dispatch
      if (event.data instanceof ArrayBuffer) {
        this.handleBinaryFrame(new Uint8Array(event.data))
        return
      }

      if (typeof event.data !== "string") return

      this.handleMessage(event.data)
    }

    socket.onerror = () => {
      if (socket === this.socket) {
        socket.close()
      }
    }

    socket.onclose = () => {
      if (socket !== this.socket) return

      this.socket = null

      if (this.destroyed || !this.shouldReconnect) {
        this.setConnectionState("disconnected")
        return
      }

      this.scheduleReconnect()
    }
  }

  private async authenticateSocket(socket: WebSocket): Promise<void> {
    if (this.destroyed || socket !== this.socket) return

    try {
      const token = await this.config.getToken()
      if (this.destroyed || socket !== this.socket) return
      if (socket.readyState !== WS_OPEN) return

      this.send(controlEnvelope(CONTROL_OP.AUTH, { token }))
    } catch {
      // Auth token unavailable — close and don't reconnect
      this.shouldReconnect = false
      socket.close()
    }
  }

  // -----------------------------------------------------------------------
  // Message dispatch
  // -----------------------------------------------------------------------

  private handleMessage(raw: string): void {
    const msg = parseEnvelope(raw)
    if (!msg) return

    switch (msg.kind) {
      case "control":
        this.handleControl(msg)
        break
      case "notify":
        this.config.onNotify?.(msg)
        break
      case "stream":
        this.config.onStream?.(msg)
        break
      case "error":
        this.config.onError?.(msg)
        break
    }
  }

  private handleControl(msg: Envelope): void {
    // Ping → respond with pong
    if (msg.op === CONTROL_RESPONSE_OP.PING) {
      this.send(controlEnvelope(CONTROL_OP.PONG))
      return
    }

    // Connected → auth succeeded, reset reconnect counter
    if (msg.op === CONTROL_RESPONSE_OP.CONNECTED) {
      this.reconnectAttempt = 0
      this.setConnectionState("connected")
    }

    // Forward all control messages to the consumer callback
    this.config.onControl?.(msg)
  }

  // -----------------------------------------------------------------------
  // Binary frame handling
  // -----------------------------------------------------------------------

  /**
   * Parse a binary frame: read bytes until first 0x00 to extract the
   * UTF-8 subId routing prefix, then dispatch the remaining payload.
   */
  private handleBinaryFrame(frame: Uint8Array): void {
    // Find the null byte delimiter
    const delimIndex = frame.indexOf(0x00)
    if (delimIndex < 0) return // malformed — no delimiter

    const decoder = new TextDecoder()
    const subId = decoder.decode(frame.subarray(0, delimIndex))
    const payload = frame.subarray(delimIndex + 1)

    this.config.onBinaryMessage?.(subId, payload)
  }

  // -----------------------------------------------------------------------
  // Reconnection — exponential backoff with jitter
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.destroyed || !this.shouldReconnect) return

    this.clearReconnectTimer()
    this.setConnectionState("reconnecting")

    const attempt = this.reconnectAttempt
    const baseDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** attempt,
    )
    const jitter = baseDelay * RECONNECT_JITTER_FACTOR * (Math.random() * 2 - 1)
    const delayMs = Math.max(RECONNECT_MIN_DELAY_MS, Math.round(baseDelay + jitter))

    this.reconnectAttempt = attempt + 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.destroyed || !this.shouldReconnect) return
      this.openSocket()
    }, delayMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  // -----------------------------------------------------------------------
  // Socket helpers
  // -----------------------------------------------------------------------

  private closeSocket(): void {
    if (this.socket === null) return
    const socket = this.socket
    this.socket = null
    socket.close()
  }

  // -----------------------------------------------------------------------
  // State management
  // -----------------------------------------------------------------------

  private setConnectionState(nextState: ConnectionState): void {
    if (this.connectionState === nextState) return
    this.connectionState = nextState

    // Notify external listener
    this.config.onStateChange?.(nextState)

    // Notify useSyncExternalStore subscribers
    for (const callback of this.subscribers) {
      callback()
    }
  }
}

// ---------------------------------------------------------------------------
// URL helper
// ---------------------------------------------------------------------------

/**
 * Build a WS URL from a path, using the current page origin.
 * Swaps http→ws, https→wss.
 */
export function buildWsUrl(path: string): string {
  const base = getWsBaseOrigin()
  const url = new URL(path, base)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function getWsBaseOrigin(): string {
  if (
    typeof window !== "undefined" &&
    typeof window.location?.origin === "string"
  ) {
    return window.location.origin
  }
  return "http://localhost:8080"
}
