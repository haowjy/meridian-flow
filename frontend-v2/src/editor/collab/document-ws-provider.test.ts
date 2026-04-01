import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import { Awareness } from "y-protocols/awareness"
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import { createDocumentWsProvider } from "./document-ws-provider"
import type { ConnectionState, ProviderControlEvent } from "../session/types"

const DOC_WS_PREFIX_SYNC = 0x00
const DOC_WS_PREFIX_AWARENESS = 0x01
const HEARTBEAT_TIMEOUT_MS = 65_000

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  static instances: MockWebSocket[] = []

  readonly url: string
  binaryType: BinaryType = "blob"
  readyState = MockWebSocket.CONNECTING
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView | Blob> = []

  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string | ArrayBufferLike | ArrayBufferView | Blob): void {
    this.sent.push(data)
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent("close"))
  }

  openFromServer(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event("open"))
  }

  receiveTextFromServer(payload: unknown): void {
    const data = typeof payload === "string" ? payload : JSON.stringify(payload)
    this.onmessage?.(new MessageEvent("message", { data }))
  }

  receiveBinaryFromServer(payload: Uint8Array): void {
    // Match real browser delivery shape (ArrayBuffer when binaryType=arraybuffer)
    const data = payload.buffer.slice(
      payload.byteOffset,
      payload.byteOffset + payload.byteLength,
    )
    this.onmessage?.(new MessageEvent("message", { data }))
  }

  closeFromServer(): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent("close"))
  }
}

function getLatestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances.at(-1)
  if (!socket) {
    throw new Error("expected websocket instance")
  }
  return socket
}

function sentBinaryFrames(socket: MockWebSocket): Uint8Array[] {
  const frames: Uint8Array[] = []
  for (const sent of socket.sent) {
    if (typeof sent === "string") continue
    if (sent instanceof Uint8Array) {
      frames.push(sent)
      continue
    }
    if (sent instanceof ArrayBuffer) {
      frames.push(new Uint8Array(sent))
      continue
    }
    if (ArrayBuffer.isView(sent)) {
      frames.push(new Uint8Array(sent.buffer, sent.byteOffset, sent.byteLength))
    }
  }
  return frames
}

function encodeServerSyncStep1(ydoc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  syncProtocol.writeSyncStep1(encoder, ydoc)
  return frameWithPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder))
}

function encodeServerSyncUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  syncProtocol.writeUpdate(encoder, update)
  return frameWithPrefix(DOC_WS_PREFIX_SYNC, encoding.toUint8Array(encoder))
}

function frameWithPrefix(prefix: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(1 + payload.length)
  framed[0] = prefix
  framed.set(payload, 1)
  return framed
}

function readSyncMessageType(frame: Uint8Array): number {
  expect(frame[0]).toBe(DOC_WS_PREFIX_SYNC)
  const decoder = decoding.createDecoder(frame.subarray(1))
  return decoding.readVarUint(decoder)
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe("document-ws-provider", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal("WebSocket", MockWebSocket as unknown as typeof WebSocket)
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    MockWebSocket.instances = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("connects and runs the y-protocol sync handshake sequence", async () => {
    const ydoc = new Y.Doc()
    ydoc.getText("content").insert(0, "client")
    const awareness = new Awareness(ydoc)
    const getAccessToken = vi.fn().mockResolvedValue("token-1")
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken,
    })

    const controlEvents: ProviderControlEvent[] = []
    provider.onControlEvent((event) => {
      controlEvents.push(event)
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()

    expect(getAccessToken).toHaveBeenCalledTimes(1)
    expect(socket.sent[0]).toBe("token-1")

    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })
    expect(controlEvents).toContainEqual({ type: "connected" })

    const framesAfterConnected = sentBinaryFrames(socket)
    expect(framesAfterConnected).toHaveLength(1)
    expect(readSyncMessageType(framesAfterConnected[0])).toBe(0)

    const serverDoc = new Y.Doc()
    serverDoc.getText("content").insert(0, "server")
    socket.receiveBinaryFromServer(encodeServerSyncStep1(serverDoc))
    await flushMicrotasks()

    const framesAfterServerStep1 = sentBinaryFrames(socket)
    expect(framesAfterServerStep1).toHaveLength(2)
    expect(readSyncMessageType(framesAfterServerStep1[1])).toBe(1)

    provider.destroy()
    awareness.destroy()
    serverDoc.destroy()
    ydoc.destroy()
  })

  it("responds to server heartbeat pings with heartbeat pongs", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()
    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })

    socket.receiveTextFromServer({ type: "heartbeat" })
    expect(socket.sent).toContain(JSON.stringify({ type: "heartbeat" }))

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("triggers reconnect when heartbeat goes stale", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    const states: ConnectionState[] = []
    provider.onConnectionState((state) => {
      states.push(state)
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()
    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })

    await vi.advanceTimersByTimeAsync(HEARTBEAT_TIMEOUT_MS + 1)
    expect(states).toContain("reconnecting")

    await vi.advanceTimersByTimeAsync(250)
    expect(MockWebSocket.instances).toHaveLength(2)

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("uses exponential reconnect backoff", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    provider.connect()
    const first = getLatestSocket()
    first.closeFromServer()

    await vi.advanceTimersByTimeAsync(249)
    expect(MockWebSocket.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances).toHaveLength(2)

    const second = getLatestSocket()
    second.closeFromServer()

    await vi.advanceTimersByTimeAsync(499)
    expect(MockWebSocket.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(MockWebSocket.instances).toHaveLength(3)

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("refreshes auth and reconnects on AUTH_EXPIRED", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce("token-initial")
      .mockResolvedValueOnce("token-refresh")

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken,
    })

    const controlEvents: ProviderControlEvent[] = []
    provider.onControlEvent((event) => {
      controlEvents.push(event)
    })

    provider.connect()
    const firstSocket = getLatestSocket()
    firstSocket.openFromServer()
    await flushMicrotasks()
    firstSocket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })

    firstSocket.receiveTextFromServer({
      type: "error",
      code: "AUTH_EXPIRED",
      message: "token expired",
    })
    await flushMicrotasks()

    expect(controlEvents).toContainEqual({ type: "auth-expired" })
    expect(getAccessToken).toHaveBeenCalledTimes(2)
    expect(MockWebSocket.instances).toHaveLength(2)

    const secondSocket = getLatestSocket()
    secondSocket.openFromServer()
    await flushMicrotasks()
    expect(secondSocket.sent[0]).toBe("token-refresh")

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("emits access-revoked and does not auto-reconnect for 403/404", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    const controlEvents: ProviderControlEvent[] = []
    provider.onControlEvent((event) => {
      controlEvents.push(event)
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()
    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })

    socket.receiveTextFromServer({
      type: "error",
      code: "FORBIDDEN",
      status: 403,
      message: "access denied",
    })

    expect(controlEvents).toContainEqual({ type: "access-revoked", status: 403 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances).toHaveLength(1)

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("emits rate-limited control event with retryAfterMs", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    const controlEvents: ProviderControlEvent[] = []
    provider.onControlEvent((event) => {
      controlEvents.push(event)
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()
    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })

    socket.receiveTextFromServer({
      type: "error",
      code: "RATE_LIMITED",
      message: "slow down",
      retryAfterMs: 1500,
    })

    expect(controlEvents).toContainEqual({
      type: "rate-limited",
      retryAfterMs: 1500,
    })

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("emits document-restored control event", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    const controlEvents: ProviderControlEvent[] = []
    provider.onControlEvent((event) => {
      controlEvents.push(event)
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()

    socket.receiveTextFromServer({ type: "document:restored", document_id: "doc-1" })
    expect(controlEvents).toContainEqual({ type: "document-restored" })

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("destroy cleans up socket/timers and stops reconnect activity", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()
    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })

    provider.destroy()
    expect(socket.readyState).toBe(MockWebSocket.CLOSED)

    await vi.advanceTimersByTimeAsync(120_000)
    expect(MockWebSocket.instances).toHaveLength(1)

    awareness.destroy()
    ydoc.destroy()
  })

  it("does not re-broadcast provider-applied Y.Doc updates", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()
    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })
    socket.sent.length = 0

    const serverDoc = new Y.Doc()
    serverDoc.getText("content").insert(0, "remote text")
    socket.receiveBinaryFromServer(
      encodeServerSyncUpdate(Y.encodeStateAsUpdate(serverDoc)),
    )
    await flushMicrotasks()

    expect(ydoc.getText("content").toString()).toBe("remote text")
    expect(socket.sent).toEqual([])

    provider.destroy()
    awareness.destroy()
    serverDoc.destroy()
    ydoc.destroy()
  })

  it("sends and applies awareness updates", async () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      getAccessToken: vi.fn().mockResolvedValue("token-1"),
    })

    provider.connect()
    const socket = getLatestSocket()
    socket.openFromServer()
    await flushMicrotasks()
    socket.receiveTextFromServer({ type: "connected", protocol: 1, stateSize: 0 })

    const localAwarenessUpdate = new Uint8Array([1, 2, 3])
    provider.sendAwarenessUpdate(localAwarenessUpdate)
    const outgoing = sentBinaryFrames(socket).at(-1)
    expect(outgoing?.[0]).toBe(DOC_WS_PREFIX_AWARENESS)

    const remoteDoc = new Y.Doc()
    const remoteAwareness = new Awareness(remoteDoc)
    remoteAwareness.setLocalState({ user: { name: "Remote User" } })
    const clients = Array.from(remoteAwareness.getStates().keys())
    const encoded = awarenessProtocol.encodeAwarenessUpdate(remoteAwareness, clients)

    socket.receiveBinaryFromServer(frameWithPrefix(DOC_WS_PREFIX_AWARENESS, encoded))
    expect(awareness.getStates().size).toBe(1)

    provider.destroy()
    awareness.destroy()
    remoteAwareness.destroy()
    remoteDoc.destroy()
    ydoc.destroy()
  })
})
