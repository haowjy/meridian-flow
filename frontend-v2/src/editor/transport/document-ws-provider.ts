// ═══════════════════════════════════════════════════════════════════
// DocumentWsProviderImpl — thin adapter over DocStreamClient.
//
// NO own WS connection, NO auth, NO heartbeat, NO reconnection.
// All connection lifecycle is handled by DocWsProvider + WsClient.
// This class just delegates to DocStreamClient for Yjs CRDT sync:
//
//   connect()    → docStreamClient.subscribe(documentId, ...)
//   disconnect() → unsubscribe()
//   doc update   → docStreamClient.sendSyncMessage(documentId, ...)
//   sync event   → apply via y-protocols/sync
//   awareness    → apply via y-protocols/awareness
//
// handleEnded("document_restored") emits a control event and does
// NOT auto-reconnect (D41: restore flow broadcasts before session
// rebuild, so immediate re-subscribe would hit a frozen session).
// ═══════════════════════════════════════════════════════════════════

import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as awarenessProtocol from "y-protocols/awareness"
import * as syncProtocol from "y-protocols/sync"
import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"

import type { DocStreamClient } from "@/lib/ws/doc-stream-client"

import type {
  ConnectionState,
  DocumentWsProvider,
  DocumentWsProviderFactory,
  ProviderControlEvent,
} from "../session/types"

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class DocumentWsProviderImpl implements DocumentWsProvider {
  private readonly documentId: string
  private readonly ydoc: Y.Doc
  private readonly awareness: Awareness
  private readonly docStreamClient: DocStreamClient
  private readonly connectionListeners = new Set<
    (state: ConnectionState) => void
  >()
  private readonly controlListeners = new Set<
    (event: ProviderControlEvent) => void
  >()
  private readonly syncOrigin = Symbol("doc-ws-provider-sync-origin")

  private unsubscribeFn: (() => void) | null = null
  private destroyed = false

  constructor(args: {
    documentId: string
    ydoc: Y.Doc
    awareness: Awareness
    docStreamClient: DocStreamClient
  }) {
    this.documentId = args.documentId
    this.ydoc = args.ydoc
    this.awareness = args.awareness
    this.docStreamClient = args.docStreamClient

    // Listen for local Yjs doc updates → send to server
    this.ydoc.on("update", this.handleDocUpdate)
  }

  connect(): void {
    if (this.destroyed) return
    if (this.unsubscribeFn) return // already connected

    this.unsubscribeFn = this.docStreamClient.subscribe(this.documentId, {
      ydoc: this.ydoc,
      awareness: this.awareness,
      onSyncEvent: (data) => this.handleSyncPayload(data),
      onAwarenessEvent: (data) => this.handleAwarenessPayload(data),
      onEnded: (reason) => this.handleEnded(reason),
    })

    this.setConnectionState("connecting")
  }

  disconnect(): void {
    if (this.unsubscribeFn) {
      this.unsubscribeFn()
      this.unsubscribeFn = null
    }
    this.setConnectionState("disconnected")
  }

  sendAwarenessUpdate(update: Uint8Array): void {
    if (update.length === 0) return
    this.docStreamClient.sendAwarenessMessage(this.documentId, update)
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

  // -----------------------------------------------------------------------
  // Internal: Yjs sync handling
  // -----------------------------------------------------------------------

  /**
   * Local Y.Doc update → encode and send to server via DocStreamClient.
   *
   * Arrow function preserves `this` for ydoc.on/off binding.
   * Ignores updates originating from remote sync (syncOrigin) to
   * prevent echo loops.
   */
  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this.syncOrigin) return
    const encoder = encoding.createEncoder()
    syncProtocol.writeUpdate(encoder, update)
    this.docStreamClient.sendSyncMessage(
      this.documentId,
      encoding.toUint8Array(encoder),
    )
  }

  /**
   * Incoming Yjs sync payload from server — process via y-protocols/sync.
   *
   * readSyncMessage handles all three sync message types:
   *   - sync step 1 → writes sync step 2 response
   *   - sync step 2 → applies remote state
   *   - update → applies incremental update
   *
   * If a response is generated (sync step 2), send it back.
   */
  private handleSyncPayload(data: Uint8Array): void {
    const decoder = decoding.createDecoder(data)
    const encoder = encoding.createEncoder()

    syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, this.syncOrigin)

    const response = encoding.toUint8Array(encoder)
    if (response.length > 0) {
      this.docStreamClient.sendSyncMessage(this.documentId, response)
    }

    // After processing sync, we're connected and synced.
    // Mark on DocStreamClient so activeDocSubscriptions reflects "synced".
    if (this.connectionState !== "connected") {
      this.setConnectionState("connected")
      this.docStreamClient.markSynced(this.documentId)
      this.emitControl({ type: "connected" })
    }
  }

  /**
   * Incoming awareness update from server — apply to local awareness.
   */
  private handleAwarenessPayload(data: Uint8Array): void {
    awarenessProtocol.applyAwarenessUpdate(this.awareness, data, this)
  }

  /**
   * Stream ended for this document subscription.
   *
   * document_restored: emit control event, do NOT auto-reconnect (D41).
   * The restore flow broadcasts before the session is rebuilt, so
   * immediate re-subscribe would hit a frozen session.
   *
   * Other reasons: clean up subscription state.
   */
  private handleEnded(reason: string): void {
    if (reason === "document_restored") {
      this.emitControl({ type: "document-restored" })
      return
    }
    // Other ended reasons — subscription is gone, mark disconnected
    this.setConnectionState("disconnected")
  }

  // -----------------------------------------------------------------------
  // State management
  // -----------------------------------------------------------------------

  private connectionState: ConnectionState = "disconnected"

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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export const createDocumentWsProvider: DocumentWsProviderFactory = (args) => {
  return new DocumentWsProviderImpl(args)
}
