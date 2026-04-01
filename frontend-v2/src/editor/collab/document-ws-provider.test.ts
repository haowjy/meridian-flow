import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as awarenessProtocol from "y-protocols/awareness"
import { Awareness } from "y-protocols/awareness"
import * as encoding from "lib0/encoding"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"

import { createDocumentWsProvider } from "./document-ws-provider"
import type { ConnectionState, ProviderControlEvent } from "../session/types"
import type { DocStreamClient, DocSubscribeOptions } from "@/lib/ws/doc-stream-client"

// ---------------------------------------------------------------------------
// Mock DocStreamClient
// ---------------------------------------------------------------------------

interface MockSubscription {
  documentId: string
  options: DocSubscribeOptions
  unsubscribed: boolean
}

function createMockDocStreamClient(): DocStreamClient & {
  subscriptions: MockSubscription[]
  lastSubscription: () => MockSubscription
  sentSyncMessages: Array<{ documentId: string; data: Uint8Array }>
  sentAwarenessMessages: Array<{ documentId: string; data: Uint8Array }>
} {
  const subscriptions: MockSubscription[] = []
  const sentSyncMessages: Array<{ documentId: string; data: Uint8Array }> = []
  const sentAwarenessMessages: Array<{ documentId: string; data: Uint8Array }> = []

  return {
    subscriptions,
    sentSyncMessages,
    sentAwarenessMessages,
    lastSubscription: () => {
      const sub = subscriptions.at(-1)
      if (!sub) throw new Error("no subscriptions")
      return sub
    },

    subscribe: vi.fn((documentId: string, options: DocSubscribeOptions) => {
      const sub: MockSubscription = { documentId, options, unsubscribed: false }
      subscriptions.push(sub)
      return () => {
        sub.unsubscribed = true
      }
    }),

    unsubscribe: vi.fn(),

    sendSyncMessage: vi.fn((documentId: string, data: Uint8Array) => {
      sentSyncMessages.push({ documentId, data })
    }),

    sendAwarenessMessage: vi.fn((documentId: string, data: Uint8Array) => {
      sentAwarenessMessages.push({ documentId, data })
    }),

    get activeDocSubscriptions() {
      return new Map()
    },

    markSynced: vi.fn(),
    handleStreamEvent: vi.fn(),
    handleControlMessage: vi.fn(),
    handleErrorMessage: vi.fn(),
    handleBinaryMessage: vi.fn(),
    handleReconnect: vi.fn(),
    destroy: vi.fn(),
  }
}

describe("document-ws-provider (thin adapter over DocStreamClient)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it("connect() subscribes to DocStreamClient with document callbacks", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()

    expect(mockClient.subscribe).toHaveBeenCalledTimes(1)
    expect(mockClient.subscribe).toHaveBeenCalledWith(
      "doc-1",
      expect.objectContaining({
        ydoc,
        awareness,
        onSyncEvent: expect.any(Function),
        onAwarenessEvent: expect.any(Function),
        onEnded: expect.any(Function),
      }),
    )

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("disconnect() calls the unsubscribe function from DocStreamClient", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()
    const sub = mockClient.lastSubscription()
    expect(sub.unsubscribed).toBe(false)

    provider.disconnect()
    expect(sub.unsubscribed).toBe(true)

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("processes incoming sync payloads via y-protocols/sync", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()
    const sub = mockClient.lastSubscription()

    // Simulate server sending sync step 1
    const serverDoc = new Y.Doc()
    serverDoc.getText("content").insert(0, "server text")
    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep1(encoder, serverDoc)
    const syncStep1Data = encoding.toUint8Array(encoder)

    // Deliver sync step 1 to the provider
    sub.options.onSyncEvent!(syncStep1Data)

    // Provider should have sent a sync step 2 response
    expect(mockClient.sentSyncMessages.length).toBeGreaterThanOrEqual(1)

    provider.destroy()
    awareness.destroy()
    serverDoc.destroy()
    ydoc.destroy()
  })

  it("sends local doc updates as sync messages via DocStreamClient", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()

    // Make a local edit
    ydoc.getText("content").insert(0, "local edit")

    // Provider should send the update via DocStreamClient
    expect(mockClient.sentSyncMessages.length).toBeGreaterThanOrEqual(1)
    const lastMsg = mockClient.sentSyncMessages.at(-1)!
    expect(lastMsg.documentId).toBe("doc-1")

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("does not re-broadcast provider-applied Y.Doc updates (echo prevention)", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()
    const sub = mockClient.lastSubscription()

    // Clear any initial messages
    mockClient.sentSyncMessages.length = 0

    // Simulate server sending a sync update (remote text change)
    const serverDoc = new Y.Doc()
    serverDoc.getText("content").insert(0, "remote text")
    const encoder = encoding.createEncoder()
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(serverDoc))
    const updateData = encoding.toUint8Array(encoder)

    sub.options.onSyncEvent!(updateData)

    // The doc should have the remote text
    expect(ydoc.getText("content").toString()).toBe("remote text")

    // Provider should NOT have sent the update back (echo prevention)
    // The only sent messages should be sync responses, not echoed updates
    // Any messages sent should be sync protocol responses (step 2), not the update itself
    // We just verify no message was the exact update we applied
    expect(mockClient.sentSyncMessages.length).toBe(0)

    provider.destroy()
    awareness.destroy()
    serverDoc.destroy()
    ydoc.destroy()
  })

  it("sends and applies awareness updates", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()
    const sub = mockClient.lastSubscription()

    // Send a local awareness update
    const localAwarenessUpdate = new Uint8Array([1, 2, 3])
    provider.sendAwarenessUpdate(localAwarenessUpdate)

    expect(mockClient.sentAwarenessMessages).toHaveLength(1)
    expect(mockClient.sentAwarenessMessages[0].documentId).toBe("doc-1")

    // Apply a remote awareness update
    const remoteDoc = new Y.Doc()
    const remoteAwareness = new Awareness(remoteDoc)
    remoteAwareness.setLocalState({ user: { name: "Remote User" } })
    const clients = Array.from(remoteAwareness.getStates().keys())
    const encoded = awarenessProtocol.encodeAwarenessUpdate(
      remoteAwareness,
      clients,
    )

    sub.options.onAwarenessEvent!(encoded)
    // Local awareness + remote awareness = 2 states
    expect(awareness.getStates().size).toBe(2)

    provider.destroy()
    awareness.destroy()
    remoteAwareness.destroy()
    remoteDoc.destroy()
    ydoc.destroy()
  })

  it("emits document-restored control event and does NOT auto-reconnect (D41)", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    const controlEvents: ProviderControlEvent[] = []
    provider.onControlEvent((event) => {
      controlEvents.push(event)
    })

    provider.connect()
    const sub = mockClient.lastSubscription()

    // Simulate document_restored ended event
    sub.options.onEnded!("document_restored")

    expect(controlEvents).toContainEqual({ type: "document-restored" })
    // Should NOT have called subscribe again (no auto-reconnect)
    expect(mockClient.subscribe).toHaveBeenCalledTimes(1)

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("emits connected control event after first sync payload", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    const states: ConnectionState[] = []
    provider.onConnectionState((state) => {
      states.push(state)
    })

    const controlEvents: ProviderControlEvent[] = []
    provider.onControlEvent((event) => {
      controlEvents.push(event)
    })

    provider.connect()
    // Initial state should be "connecting" (connect() was called)
    expect(states).toContain("connecting")

    const sub = mockClient.lastSubscription()

    // Simulate server sending sync step 1
    const serverDoc = new Y.Doc()
    const encoder = encoding.createEncoder()
    syncProtocol.writeSyncStep1(encoder, serverDoc)
    sub.options.onSyncEvent!(encoding.toUint8Array(encoder))

    // After processing sync, state should be "connected"
    expect(states).toContain("connected")
    expect(controlEvents).toContainEqual({ type: "connected" })

    provider.destroy()
    awareness.destroy()
    serverDoc.destroy()
    ydoc.destroy()
  })

  it("destroy cleans up ydoc listener and unsubscribes", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()
    const sub = mockClient.lastSubscription()

    provider.destroy()
    expect(sub.unsubscribed).toBe(true)

    // After destroy, local edits should NOT send messages
    mockClient.sentSyncMessages.length = 0
    ydoc.getText("content").insert(0, "after destroy")
    expect(mockClient.sentSyncMessages).toHaveLength(0)

    awareness.destroy()
    ydoc.destroy()
  })

  it("skips empty awareness updates", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()

    provider.sendAwarenessUpdate(new Uint8Array(0))
    expect(mockClient.sentAwarenessMessages).toHaveLength(0)

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("connect is idempotent when already connected", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    provider.connect()
    provider.connect() // second call should be no-op

    expect(mockClient.subscribe).toHaveBeenCalledTimes(1)

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })

  it("sets disconnected state on non-restored ended events", () => {
    const ydoc = new Y.Doc()
    const awareness = new Awareness(ydoc)
    const mockClient = createMockDocStreamClient()

    const provider = createDocumentWsProvider({
      documentId: "doc-1",
      ydoc,
      awareness,
      docStreamClient: mockClient,
    })

    const states: ConnectionState[] = []
    provider.onConnectionState((state) => {
      states.push(state)
    })

    provider.connect()
    const sub = mockClient.lastSubscription()

    // Simulate a non-restored ended event
    sub.options.onEnded!("server_shutdown")

    expect(states).toContain("disconnected")

    provider.destroy()
    awareness.destroy()
    ydoc.destroy()
  })
})
