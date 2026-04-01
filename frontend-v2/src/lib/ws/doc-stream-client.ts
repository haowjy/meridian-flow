// ═══════════════════════════════════════════════════════════════════
// DocStreamClient — manages document stream subscriptions for Yjs
// CRDT sync over the doc WS connection.
//
// Analogous to StreamingChannelClient for threads. Subscribes to
// document resources, routes binary frames (Yjs sync/awareness),
// handles reconnect by re-subscribing fresh (no lastSeq/epoch —
// CRDTs converge naturally).
//
// Binary frame payload prefix bytes:
//   0x00 = Yjs sync protocol message
//   0x01 = Yjs awareness update
// ═══════════════════════════════════════════════════════════════════

import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"

import type { Envelope, EnvelopeResource } from "./protocol"
import { CONTROL_OP, CONTROL_RESPONSE_OP, STREAM_OP } from "./protocol"
import type { WsClient } from "./ws-client"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOC_PREFIX_SYNC = 0x00
const DOC_PREFIX_AWARENESS = 0x01

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for subscribing to a document's Yjs sync stream. */
export interface DocSubscribeOptions {
  ydoc: Y.Doc
  awareness: Awareness
  onSyncEvent?: (data: Uint8Array) => void
  onAwarenessEvent?: (data: Uint8Array) => void
  onEnded?: (reason: string) => void
}

/** Subscription state exposed for introspection. */
export interface DocSubscriptionState {
  documentId: string
  subId: string
  connectionState: "subscribing" | "syncing" | "synced"
}

/** Internal subscription record. */
interface DocSubscription {
  documentId: string
  subId: string
  options: DocSubscribeOptions
  connectionState: "subscribing" | "syncing" | "synced"
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSubId(): string {
  return `d-${crypto.randomUUID()}`
}

// ---------------------------------------------------------------------------
// DocStreamClient
// ---------------------------------------------------------------------------

/**
 * Manages document stream subscriptions for Yjs CRDT sync.
 *
 * The WsClient handles connection lifecycle (auth, heartbeat, reconnect).
 * This client sits on top and manages document subscriptions:
 *   - subscribe/unsubscribe to document Yjs sync streams
 *   - route incoming binary frames to subscriber callbacks
 *   - send Yjs sync/awareness data via binary frames
 *   - reconnect re-subscribe (fresh, no lastSeq/epoch — CRDT convergence)
 */
export class DocStreamClient {
  private readonly wsClient: WsClient

  // Subscriptions keyed by subId
  private readonly subs = new Map<string, DocSubscription>()
  // Reverse lookup: documentId → subId
  private readonly docToSub = new Map<string, string>()

  constructor(wsClient: WsClient) {
    this.wsClient = wsClient
  }

  // -----------------------------------------------------------------------
  // Public: subscribe / unsubscribe / send
  // -----------------------------------------------------------------------

  /**
   * Subscribe to a document for Yjs sync. Returns a cleanup function.
   *
   * On subscribe: sends control:subscribe with resource type "document".
   * Server responds with subscribed + initial sync step 1 binary frame.
   *
   * If there's already an active subscription for this documentId,
   * the old one is silently replaced (dedup per D42).
   */
  subscribe(documentId: string, options: DocSubscribeOptions): () => void {
    // Clean up any existing subscription for this document
    const existingSubId = this.docToSub.get(documentId)
    if (existingSubId) {
      this.removeSub(existingSubId)
      // Send unsubscribe for old sub
      this.wsClient.send({
        kind: "control",
        op: CONTROL_OP.UNSUBSCRIBE,
        subId: existingSubId,
      })
    }

    const subId = generateSubId()
    const sub: DocSubscription = {
      documentId,
      subId,
      options,
      connectionState: "subscribing",
    }

    this.subs.set(subId, sub)
    this.docToSub.set(documentId, subId)

    // Send subscribe envelope
    const resource: EnvelopeResource = { type: "document", id: documentId }

    this.wsClient.send({
      kind: "control",
      op: CONTROL_OP.SUBSCRIBE,
      resource,
      subId,
      payload: {}, // No lastSeq/epoch — CRDT convergence (D38)
    })

    return () => {
      this.unsubscribe(documentId)
    }
  }

  /**
   * Unsubscribe from a document's sync stream.
   */
  unsubscribe(documentId: string): void {
    const subId = this.docToSub.get(documentId)
    if (!subId) return

    // Send unsubscribe envelope before removing local state
    this.wsClient.send({
      kind: "control",
      op: CONTROL_OP.UNSUBSCRIBE,
      subId,
    })

    this.removeSub(subId)
  }

  /**
   * Send a Yjs sync message for a document.
   * Prepends the sync prefix byte (0x00) and sends via binary frame.
   */
  sendSyncMessage(documentId: string, data: Uint8Array): void {
    const subId = this.docToSub.get(documentId)
    if (!subId) return

    const prefixed = new Uint8Array(1 + data.length)
    prefixed[0] = DOC_PREFIX_SYNC
    prefixed.set(data, 1)

    this.wsClient.sendBinary(subId, prefixed)
  }

  /**
   * Send a Yjs awareness update for a document.
   * Prepends the awareness prefix byte (0x01) and sends via binary frame.
   */
  sendAwarenessMessage(documentId: string, data: Uint8Array): void {
    const subId = this.docToSub.get(documentId)
    if (!subId) return

    const prefixed = new Uint8Array(1 + data.length)
    prefixed[0] = DOC_PREFIX_AWARENESS
    prefixed.set(data, 1)

    this.wsClient.sendBinary(subId, prefixed)
  }

  /**
   * Mark a document subscription as fully synced.
   * Called by the consumer (DocumentWsProviderImpl) after the initial
   * Yjs sync exchange completes (sync step 1 received + step 2 sent).
   */
  markSynced(documentId: string): void {
    const subId = this.docToSub.get(documentId)
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    if (sub.connectionState === "syncing") {
      sub.connectionState = "synced"
    }
  }

  /** Read-only view of active subscriptions. */
  get activeDocSubscriptions(): ReadonlyMap<string, DocSubscriptionState> {
    const result = new Map<string, DocSubscriptionState>()
    for (const [subId, sub] of this.subs) {
      result.set(subId, {
        documentId: sub.documentId,
        subId: sub.subId,
        connectionState: sub.connectionState,
      })
    }
    return result
  }

  // -----------------------------------------------------------------------
  // WS event routing — called by DocWsProvider
  // -----------------------------------------------------------------------

  /**
   * Route a stream-lane JSON envelope to the appropriate subscription.
   * Handles ended and gap events. Binary data goes through
   * handleBinaryMessage() instead.
   */
  handleStreamEvent(msg: Envelope): void {
    const { op, subId } = msg

    switch (op) {
      case STREAM_OP.ENDED:
        this.handleEnded(msg, subId)
        break
      case STREAM_OP.GAP:
        this.handleGap(subId)
        break
    }
  }

  /**
   * Route a control-lane response to update subscription state.
   */
  handleControlMessage(msg: Envelope): void {
    if (msg.op === CONTROL_RESPONSE_OP.SUBSCRIBED) {
      this.handleSubscribed(msg)
    }
  }

  /**
   * Route an error-lane envelope. If it targets a subscription,
   * clean up that subscription.
   */
  handleErrorMessage(msg: Envelope): void {
    const subId = msg.subId
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    // Subscription-scoped error — treat as terminal
    this.removeSub(subId)
  }

  /**
   * Handle an incoming binary frame. The WsClient has already extracted
   * the subId routing prefix — we receive the subId and raw payload.
   *
   * Reads the Yjs prefix byte to determine message type:
   *   0x00 = sync → onSyncEvent callback
   *   0x01 = awareness → onAwarenessEvent callback
   */
  handleBinaryMessage(subId: string, data: Uint8Array): void {
    const sub = this.subs.get(subId)
    if (!sub) return
    if (data.length < 1) return

    const prefix = data[0]
    const payload = data.subarray(1)

    if (prefix === DOC_PREFIX_SYNC) {
      // Mark as syncing on first sync message received
      if (sub.connectionState === "subscribing") {
        sub.connectionState = "syncing"
      }
      sub.options.onSyncEvent?.(payload)
    } else if (prefix === DOC_PREFIX_AWARENESS) {
      sub.options.onAwarenessEvent?.(payload)
    }
  }

  /**
   * Re-subscribe all active documents after WS reconnect.
   *
   * Fresh subscribe with no lastSeq/epoch — CRDTs converge naturally
   * via sync step 1/2 exchange regardless of what was missed (D38).
   */
  handleReconnect(): void {
    // Snapshot current subs — iteration over a mutating map is risky
    const currentSubs = Array.from(this.subs.values())

    for (const sub of currentSubs) {
      const oldSubId = sub.subId
      const newSubId = generateSubId()

      // Update internal maps
      this.subs.delete(oldSubId)
      const updated: DocSubscription = {
        ...sub,
        subId: newSubId,
        connectionState: "subscribing",
      }
      this.subs.set(newSubId, updated)
      this.docToSub.set(sub.documentId, newSubId)

      // Fresh subscribe — no lastSeq/epoch (CRDT convergence)
      const resource: EnvelopeResource = {
        type: "document",
        id: sub.documentId,
      }

      this.wsClient.send({
        kind: "control",
        op: CONTROL_OP.SUBSCRIBE,
        resource,
        subId: newSubId,
        payload: {},
      })
    }
  }

  /**
   * Destroy all subscriptions and reset state.
   * Called on provider unmount.
   */
  destroy(): void {
    this.subs.clear()
    this.docToSub.clear()
  }

  // -----------------------------------------------------------------------
  // Internal handlers
  // -----------------------------------------------------------------------

  private handleSubscribed(msg: Envelope): void {
    const subId = msg.subId
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    // Server confirmed subscription — mark as syncing
    // (will receive initial sync step 1 binary frame next)
    sub.connectionState = "syncing"
  }

  private handleEnded(msg: Envelope, subId: string | undefined): void {
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    const payload = msg.payload ?? {}
    const reason = (payload.reason as string) ?? "unknown"

    // Notify callback before cleanup
    sub.options.onEnded?.(reason)

    // Clean up — server already freed the sub slot
    this.removeSub(subId)
  }

  /**
   * Gap recovery for documents: fresh re-subscribe, no REST fallback.
   * CRDTs converge naturally on re-sync (D38).
   */
  private handleGap(subId: string | undefined): void {
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    // Remove the failed subscription and re-subscribe fresh
    const { documentId, options } = sub
    this.removeSub(subId)
    this.subscribe(documentId, options)
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Remove a subscription from internal maps (no WS message sent). */
  private removeSub(subId: string): void {
    const sub = this.subs.get(subId)
    if (!sub) return

    this.subs.delete(subId)

    // Only remove the docToSub entry if it still points to this subId.
    // A newer subscription for the same document may have already replaced it.
    if (this.docToSub.get(sub.documentId) === subId) {
      this.docToSub.delete(sub.documentId)
    }
  }
}
