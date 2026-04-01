import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"

import type {
  ConnectionState,
  DocumentWsProvider,
  DocumentWsProviderFactory,
  ProviderControlEvent,
} from "../session/types"

const DOC_WS_PREFIX_SYNC = 0x00
const DOC_WS_PREFIX_AWARENESS = 0x01
const WS_OPEN = 1

const HEARTBEAT_TIMEOUT_MS = 65_000
const RECONNECT_BASE_DELAY_MS = 250
const RECONNECT_MAX_DELAY_MS = 5_000
const RECONNECT_MIN_DELAY_MS = 100
const RECONNECT_JITTER_FACTOR = 0.15

interface ProviderArgs {
  documentId: string
  ydoc: Y.Doc
  awareness: Awareness
  getAccessToken: () => Promise<string>
}

interface ServerEventBase {
  type: string
}

interface ServerErrorEvent extends ServerEventBase {
  type: "error"
  code?: string
  message?: string
  status?: number
  retryAfterMs?: number
  retryAfter?: number
}

class DocumentWsProviderImpl implements DocumentWsProvider {
  private readonly documentId: string
  private readonly ydoc: Y.Doc
  private readonly awareness: Awareness
  private readonly getAccessToken: () => Promise<string>
  private readonly connectionListeners = new Set<(state: ConnectionState) => void>()
  private readonly controlListeners = new Set<(event: ProviderControlEvent) => void>()
  private readonly syncOrigin = Symbol("document-ws-provider-sync-origin")
  private readonly awarenessOrigin = Symbol("document-ws-provider-awareness-origin")

  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private destroyed = false
  private shouldReconnect = false
  private isRefreshingAuth = false
  private nextAccessToken: string | null = null
  private connectionState: ConnectionState = "disconnected"

  constructor(args: ProviderArgs) {
    this.documentId = args.documentId
    this.ydoc = args.ydoc
    this.awareness = args.awareness
    this.getAccessToken = args.getAccessToken

    this.ydoc.on("update", this.handleDocUpdate)
  }

  connect(): void {
    if (this.destroyed) return
    if (this.connectionState !== "disconnected") return

    this.shouldReconnect = true
    this.clearReconnectTimer()
    this.openSocket()
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.isRefreshingAuth = false
    this.nextAccessToken = null

    this.clearReconnectTimer()
    this.clearHeartbeatTimer()
    this.closeSocket()
    this.setConnectionState("disconnected")
  }

  sendAwarenessUpdate(update: Uint8Array): void {
    if (update.length === 0) return
    this.sendBinary(frameWithPrefix(DOC_WS_PREFIX_AWARENESS, update))
  }

  onConnectionState(listener: (state: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener)
    listener(this.connectionState)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  onControlEvent(listener: (event: ProviderControlEvent) => void): () => void {
    this.controlListeners.add(listener)
    return () => {
      this.controlListeners.delete(listener)
    }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true

    this.disconnect()
    this.ydoc.off("update", this.handleDocUpdate)
    this.connectionListeners.clear()
    this.controlListeners.clear()
  }

  private openSocket(): void {
    if (this.destroyed || !this.shouldReconnect || this.isRefreshingAuth) return
    if (this.socket !== null) return

    this.setConnectionState("connecting")
    const socket = new WebSocket(buildDocumentWsUrl(this.documentId))
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

      const data = event.data
      if (typeof data === "string") {
        this.handleTextFrame(data)
        return
      }

      void this.handleBinaryFrame(data)
    }

    socket.onerror = () => {
      if (socket === this.socket) {
        socket.close()
      }
    }

    socket.onclose = () => {
      if (socket !== this.socket) return

      this.socket = null
      this.clearHeartbeatTimer()

      if (this.destroyed || !this.shouldReconnect) {
        this.setConnectionState("disconnected")
        return
      }

      if (this.isRefreshingAuth) {
        this.setConnectionState("reconnecting")
        return
      }

      this.scheduleReconnect()
    }
  }

  private async authenticateSocket(socket: WebSocket): Promise<void> {
    if (this.destroyed || socket !== this.socket) return

    try {
      const token = await this.takeAccessTokenForConnect()
      if (this.destroyed || socket !== this.socket || !isSocketOpen(socket)) return
      socket.send(token)
    } catch (error) {
      this.emitFatal("AUTH_TOKEN_UNAVAILABLE", toErrorMessage(error))
      this.shouldReconnect = false
      socket.close()
    }
  }

  private async takeAccessTokenForConnect(): Promise<string> {
    if (this.nextAccessToken !== null) {
      const token = this.nextAccessToken
      this.nextAccessToken = null
      return token
    }

    const token = await this.getAccessToken()
    if (!token) {
      throw new Error("access token is empty")
    }
    return token
  }

  private handleTextFrame(raw: string): void {
    const event = parseServerEvent(raw)
    if (!event) return

    if (event.type === "heartbeat") {
      this.resetHeartbeatTimeout()
      this.sendText({ type: "heartbeat" })
      return
    }

    if (event.type === "connected") {
      this.reconnectAttempt = 0
      this.setConnectionState("connected")
      this.resetHeartbeatTimeout()
      this.emitControl({ type: "connected" })
      this.sendSyncStep1()
      return
    }

    if (event.type === "document:restored") {
      this.emitControl({ type: "document-restored" })
      return
    }

    if (event.type === "error") {
      this.handleErrorEvent(event as ServerErrorEvent)
    }
  }

  private handleErrorEvent(event: ServerErrorEvent): void {
    const code = event.code ?? "UNKNOWN"
    const message = event.message ?? "WebSocket error"

    if (code === "AUTH_EXPIRED") {
      this.emitControl({ type: "auth-expired" })
      void this.refreshTokenAndReconnect()
      return
    }

    if (isAccessRevokedError(event)) {
      const status = getAccessRevokedStatus(event)
      this.emitControl({ type: "access-revoked", status })
      this.shouldReconnect = false
      this.closeSocket()
      this.setConnectionState("disconnected")
      return
    }

    if (code === "RATE_LIMITED") {
      this.emitControl({
        type: "rate-limited",
        retryAfterMs: readRetryAfterMs(event),
      })
      return
    }

    this.shouldReconnect = false
    this.emitFatal(code, message)
    this.closeSocket()
    this.setConnectionState("disconnected")
  }

  private async refreshTokenAndReconnect(): Promise<void> {
    if (this.destroyed || !this.shouldReconnect || this.isRefreshingAuth) return

    this.isRefreshingAuth = true
    this.setConnectionState("reconnecting")

    try {
      const token = await this.getAccessToken()
      if (!token) {
        throw new Error("access token is empty")
      }
      this.nextAccessToken = token
    } catch (error) {
      this.shouldReconnect = false
      this.emitFatal("AUTH_REFRESH_FAILED", toErrorMessage(error))
      this.closeSocket()
      this.setConnectionState("disconnected")
      this.isRefreshingAuth = false
      return
    }

    this.closeSocket({ dropReference: true })
    this.isRefreshingAuth = false
    if (this.destroyed || !this.shouldReconnect) return
    this.openSocket()
  }

  private async handleBinaryFrame(data: unknown): Promise<void> {
    const frame = await toUint8Array(data)
    if (!frame || frame.length < 1) return

    const prefix = frame[0]
    const payload = frame.subarray(1)

    if (prefix === DOC_WS_PREFIX_SYNC) {
      this.handleSyncPayload(payload)
      return
    }

    if (prefix === DOC_WS_PREFIX_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        payload,
        this.awarenessOrigin,
      )
    }
  }

  private handleSyncPayload(payload: Uint8Array): void {
    const decoder = decoding.createDecoder(payload)
    const encoder = encoding.createEncoder()

    syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, this.syncOrigin)

    const response = encoding.toUint8Array(encoder)
    if (response.length > 0) {
      this.sendBinary(frameWithPrefix(DOC_WS_PREFIX_SYNC, response))
    }
  }

  private sendSyncStep1(): void {
    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep1(encoder, this.ydoc)
    this.sendBinary(frameWithPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder)))
  }

  private scheduleReconnect(): void {
    if (this.destroyed || !this.shouldReconnect || this.isRefreshingAuth) return

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
      if (this.destroyed || !this.shouldReconnect || this.isRefreshingAuth) return
      this.openSocket()
    }, delayMs)
  }

  private resetHeartbeatTimeout(): void {
    this.clearHeartbeatTimer()
    this.heartbeatTimer = setTimeout(() => {
      if (this.destroyed || !this.shouldReconnect || this.socket === null) return
      this.closeSocket()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
  }

  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer === null) return
    clearTimeout(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private closeSocket(options?: { dropReference?: boolean }): void {
    if (this.socket === null) return
    const socket = this.socket
    if (options?.dropReference) {
      this.socket = null
      this.clearHeartbeatTimer()
    }
    socket.close()
  }

  private sendText(data: Record<string, unknown>): void {
    if (!this.socket || !isSocketOpen(this.socket)) return
    this.socket.send(JSON.stringify(data))
  }

  private sendBinary(data: Uint8Array): void {
    if (!this.socket || !isSocketOpen(this.socket)) return
    this.socket.send(data)
  }

  private setConnectionState(nextState: ConnectionState): void {
    if (this.connectionState === nextState) return
    this.connectionState = nextState
    for (const listener of this.connectionListeners) {
      listener(nextState)
    }
  }

  private emitControl(event: ProviderControlEvent): void {
    for (const listener of this.controlListeners) {
      listener(event)
    }
  }

  private emitFatal(code: string, message: string): void {
    this.emitControl({ type: "fatal", code, message })
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this.syncOrigin) return
    const encoder = encoding.createEncoder()
    syncProtocol.writeUpdate(encoder, update)
    this.sendBinary(frameWithPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder)))
  }
}

export const createDocumentWsProvider: DocumentWsProviderFactory = (args) => {
  return new DocumentWsProviderImpl(args)
}

function buildDocumentWsUrl(documentId: string): string {
  const base = getWsBaseOrigin()
  const url = new URL(`/ws/documents/${encodeURIComponent(documentId)}`, base)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}

function getWsBaseOrigin(): string {
  if (typeof window !== "undefined" && typeof window.location?.origin === "string") {
    return window.location.origin
  }
  return "http://localhost:8080"
}

function frameWithPrefix(prefix: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(1 + payload.length)
  framed[0] = prefix
  framed.set(payload, 1)
  return framed
}

function parseServerEvent(raw: string): ServerEventBase | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      !("type" in parsed) ||
      typeof parsed.type !== "string"
    ) {
      return null
    }
    return parsed as ServerEventBase
  } catch {
    return null
  }
}

function isAccessRevokedError(event: ServerErrorEvent): boolean {
  if (event.status === 403 || event.status === 404) return true
  return event.code === "FORBIDDEN" || event.code === "DOCUMENT_NOT_FOUND"
}

function getAccessRevokedStatus(event: ServerErrorEvent): 403 | 404 {
  if (event.status === 404 || event.code === "DOCUMENT_NOT_FOUND") {
    return 404
  }
  return 403
}

function readRetryAfterMs(event: ServerErrorEvent): number | undefined {
  if (typeof event.retryAfterMs === "number") return event.retryAfterMs
  if (typeof event.retryAfter === "number") return event.retryAfter
  return undefined
}

async function toUint8Array(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof Uint8Array) {
    return data
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    const buffer = await data.arrayBuffer()
    return new Uint8Array(buffer)
  }
  return null
}

function isSocketOpen(socket: WebSocket): boolean {
  return socket.readyState === WS_OPEN
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
