// ═══════════════════════════════════════════════════════════════════
// StreamingChannelClient — manages stream subscriptions over WS.
//
// Tracks active subscriptions, handles gap recovery with livelock
// prevention, auto-follows stream_switch, and re-subscribes all
// active streams on reconnect. Exposes a useSyncExternalStore
// contract for reactive snapshots in React.
//
// Gap tracking is per-turnId (NOT per-subId). Re-subscribing creates
// a new subId, so per-subId counters reset on every attempt and
// never reach the threshold. Two consecutive gaps for the same
// turnId → stop retrying.
// ═══════════════════════════════════════════════════════════════════

import type { StreamEvent } from "@/features/activity-stream/streaming/events"
import { STREAM_EVENT_TYPE_SET } from "@/features/activity-stream/streaming/events"

import type { Envelope, EnvelopeResource } from "@/lib/ws/protocol"
import {
  CONTROL_OP,
  CONTROL_RESPONSE_OP,
  STREAM_OP,
  STREAM_CLIENT_OP,
} from "@/lib/ws/protocol"
import type { WsClient } from "@/lib/ws/ws-client"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for subscribing to a turn's stream. */
export interface SubscribeOptions {
  lastSeq?: number
  epoch?: string
  onEvent?: (event: StreamEvent) => void
  onEnded?: (reason: string, metadata: Record<string, unknown>) => void
  onGap?: (fromSeq: number, toSeq: number, cause: string) => void
}

/** Internal state for an active subscription. */
export interface SubscriptionState {
  subId: string
  turnId: string
  lastSeq: number | undefined
  epoch: string | undefined
  callbacks: SubscribeOptions
}

/** Reactive snapshot exposed via useSyncExternalStore. */
export interface StreamingSnapshot {
  /** Active subscriptions keyed by subId. */
  subscriptions: ReadonlyMap<string, SubscriptionState>
  /** Version counter — bumped on every state change. */
  version: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum consecutive gap attempts per turnId before giving up. */
const MAX_GAP_ATTEMPTS = 2

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSubId(): string {
  return `s-${crypto.randomUUID()}`
}

/**
 * Type-guard: checks if a WS payload looks like a valid AG-UI StreamEvent.
 * We validate the `type` field against the known set.
 */
function isStreamEvent(payload: unknown): payload is StreamEvent {
  if (payload == null || typeof payload !== "object") return false
  const p = payload as Record<string, unknown>
  return typeof p.type === "string" && STREAM_EVENT_TYPE_SET.has(p.type)
}

// ---------------------------------------------------------------------------
// StreamingChannelClient
// ---------------------------------------------------------------------------

/**
 * Manages stream subscriptions for turn streaming over a WsClient.
 *
 * The WsClient handles connection lifecycle (auth, heartbeat, reconnect).
 * This client sits on top and manages the stream lane:
 *   - subscribe/unsubscribe to turn streams
 *   - route incoming stream events to callbacks
 *   - gap recovery with livelock prevention
 *   - stream_switch auto-follow
 *   - reconnect re-subscribe
 *   - interjection sending
 *
 * Implements useSyncExternalStore contract for React integration.
 */
export class StreamingChannelClient {
  private readonly wsClient: WsClient

  // Subscriptions keyed by subId
  private readonly subs = new Map<string, SubscriptionState>()
  // Reverse lookup: turnId → subId (for reconnect & gap recovery)
  private readonly turnToSub = new Map<string, string>()
  // Per-turnId gap attempt counters (NOT per subId — see module doc)
  private readonly gapAttempts = new Map<string, number>()

  // useSyncExternalStore contract
  private readonly listeners = new Set<() => void>()
  private version = 0
  private snapshot: StreamingSnapshot = {
    subscriptions: new Map(),
    version: 0,
  }

  constructor(wsClient: WsClient) {
    this.wsClient = wsClient
  }

  // -----------------------------------------------------------------------
  // Public: subscribe / unsubscribe / interjection
  // -----------------------------------------------------------------------

  /**
   * Subscribe to a turn's stream. Returns a cleanup function.
   *
   * If there's already an active subscription for this turnId,
   * the old one is silently replaced.
   */
  subscribeTurn(
    turnId: string,
    options: SubscribeOptions = {},
  ): () => void {
    // Clean up any existing subscription for this turn
    const existingSub = this.turnToSub.get(turnId)
    if (existingSub) {
      this.removeSub(existingSub)
    }

    const subId = generateSubId()
    const sub: SubscriptionState = {
      subId,
      turnId,
      lastSeq: options.lastSeq,
      epoch: options.epoch,
      callbacks: options,
    }

    this.subs.set(subId, sub)
    this.turnToSub.set(turnId, subId)
    this.bump()

    // Send subscribe envelope
    const resource: EnvelopeResource = { type: "turn", id: turnId }
    const payload: Record<string, unknown> = {}
    if (options.lastSeq != null) payload.lastSeq = options.lastSeq
    if (options.epoch != null) payload.epoch = options.epoch

    this.wsClient.send({
      kind: "control",
      op: CONTROL_OP.SUBSCRIBE,
      resource,
      subId,
      payload,
    })

    return () => {
      this.unsubscribeTurn(turnId)
    }
  }

  /**
   * Unsubscribe from a turn's stream.
   */
  unsubscribeTurn(turnId: string): void {
    const subId = this.turnToSub.get(turnId)
    if (!subId) return

    // Send unsubscribe envelope before removing local state
    this.wsClient.send({
      kind: "control",
      op: CONTROL_OP.UNSUBSCRIBE,
      subId,
    })

    this.removeSub(subId)
    this.gapAttempts.delete(turnId)
    this.bump()
  }

  /**
   * Send an interjection to a streaming turn.
   */
  sendInterjection(
    turnId: string,
    text: string,
    mode: "append" | "replace",
  ): void {
    this.wsClient.send({
      kind: "stream",
      op: STREAM_CLIENT_OP.MESSAGE,
      resource: { type: "turn", id: turnId },
      payload: { text, mode },
    })
  }

  /** Read-only view of active subscriptions. */
  get activeSubscriptions(): ReadonlyMap<string, SubscriptionState> {
    return this.subs
  }

  // -----------------------------------------------------------------------
  // WS event routing — called by ThreadWsProvider
  // -----------------------------------------------------------------------

  /**
   * Route a stream-lane envelope to the appropriate subscription.
   * Called by ThreadWsProvider's onStream callback.
   */
  handleStreamMessage(msg: Envelope): void {
    const { op, subId } = msg

    switch (op) {
      case STREAM_OP.EVENT:
        this.handleStreamEvent(msg, subId)
        break
      case STREAM_OP.ENDED:
        this.handleStreamEnded(msg, subId)
        break
      case STREAM_OP.GAP:
        this.handleGap(msg, subId)
        break
    }
  }

  /**
   * Route a control-lane response to update subscription state.
   * Called by ThreadWsProvider's onControl callback.
   */
  handleControlMessage(msg: Envelope): void {
    if (msg.op === CONTROL_RESPONSE_OP.SUBSCRIBED) {
      this.handleSubscribed(msg)
    }
    // UNSUBSCRIBED is fire-and-forget; local state already cleaned up
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
    this.gapAttempts.delete(sub.turnId)
    this.bump()
  }

  /**
   * Re-subscribe all active subscriptions after WS reconnect.
   * Called by ThreadWsProvider when it receives a `connected` control message
   * following a reconnection.
   */
  resubscribeAll(): void {
    // Snapshot current subs — iteration over a mutating map is risky
    const currentSubs = Array.from(this.subs.values())

    for (const sub of currentSubs) {
      // Create a fresh subId for the new connection
      const oldSubId = sub.subId
      const newSubId = generateSubId()

      // Update internal maps
      this.subs.delete(oldSubId)
      const updated: SubscriptionState = {
        ...sub,
        subId: newSubId,
      }
      this.subs.set(newSubId, updated)
      this.turnToSub.set(sub.turnId, newSubId)

      // Send subscribe with lastSeq/epoch from last received event
      const payload: Record<string, unknown> = {}
      if (sub.lastSeq != null) payload.lastSeq = sub.lastSeq
      if (sub.epoch != null) payload.epoch = sub.epoch

      this.wsClient.send({
        kind: "control",
        op: CONTROL_OP.SUBSCRIBE,
        resource: { type: "turn", id: sub.turnId },
        subId: newSubId,
        payload,
      })
    }

    if (currentSubs.length > 0) {
      this.bump()
    }
  }

  /**
   * Destroy all subscriptions and reset state.
   * Called on provider unmount.
   */
  destroy(): void {
    this.subs.clear()
    this.turnToSub.clear()
    this.gapAttempts.clear()
    this.listeners.clear()
    this.bump()
  }

  // -----------------------------------------------------------------------
  // useSyncExternalStore contract
  // -----------------------------------------------------------------------

  /**
   * Subscribe to snapshot changes. Returns unsubscribe function.
   * Used by React's useSyncExternalStore.
   */
  subscribe = (callback: () => void): (() => void) => {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /**
   * Get the current streaming snapshot.
   * Used by React's useSyncExternalStore.
   */
  getSnapshot = (): StreamingSnapshot => {
    return this.snapshot
  }

  // -----------------------------------------------------------------------
  // Internal: stream event handling
  // -----------------------------------------------------------------------

  private handleStreamEvent(msg: Envelope, subId: string | undefined): void {
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    // Update seq/epoch tracking for reconnect catchup
    if (msg.seq != null) sub.lastSeq = msg.seq
    if (msg.epoch) sub.epoch = msg.epoch

    // Reset gap counter on successful event delivery
    this.gapAttempts.delete(sub.turnId)

    // Extract the AG-UI event from the envelope payload
    const payload = msg.payload
    if (isStreamEvent(payload)) {
      sub.callbacks.onEvent?.(payload)
    }

    this.bump()
  }

  private handleStreamEnded(msg: Envelope, subId: string | undefined): void {
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    const payload = msg.payload ?? {}
    const reason = (payload.reason as string) ?? "unknown"

    // Update seq tracking
    if (msg.seq != null) sub.lastSeq = msg.seq

    // Notify callback before cleanup
    sub.callbacks.onEnded?.(reason, payload)

    // Clean up the subscription — server already freed the sub slot
    this.removeSub(subId)
    this.gapAttempts.delete(sub.turnId)

    // Auto-follow stream_switch
    if (reason === "stream_switch") {
      const newTurnId = payload.newAssistantTurnId as string | undefined
      if (newTurnId) {
        // Re-subscribe to successor with same callbacks
        this.subscribeTurn(newTurnId, sub.callbacks)
      }
    }

    this.bump()
  }

  private handleGap(msg: Envelope, subId: string | undefined): void {
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    const payload = msg.payload ?? {}
    const fromSeq = (payload.fromSeq as number) ?? 0
    const toSeq = (payload.toSeq as number) ?? 0
    const cause = (payload.cause as string) ?? "unknown"

    // Track gap attempts per turnId
    const turnId = sub.turnId
    const attempts = (this.gapAttempts.get(turnId) ?? 0) + 1
    this.gapAttempts.set(turnId, attempts)

    // Notify callback
    sub.callbacks.onGap?.(fromSeq, toSeq, cause)

    // Clean up the failed subscription
    this.removeSub(subId)

    if (attempts >= MAX_GAP_ATTEMPTS) {
      // Two consecutive gaps for this turnId → stop retrying.
      // Server has lost the in-memory stream (restart or crash).
      // Client falls back to REST state and waits for notify.
      this.gapAttempts.delete(turnId)
      this.bump()
      return
    }

    // First gap — try re-subscribe with no lastSeq/epoch (full catchup)
    this.subscribeTurn(turnId, sub.callbacks)
  }

  private handleSubscribed(msg: Envelope): void {
    const subId = msg.subId
    if (!subId) return

    const sub = this.subs.get(subId)
    if (!sub) return

    // Update epoch from server's response
    if (msg.epoch) {
      sub.epoch = msg.epoch
    }

    this.bump()
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** Remove a subscription from internal maps (no WS message sent). */
  private removeSub(subId: string): void {
    const sub = this.subs.get(subId)
    if (!sub) return

    this.subs.delete(subId)

    // Only remove the turnToSub entry if it still points to this subId.
    // A newer subscription for the same turnId may have already replaced it.
    if (this.turnToSub.get(sub.turnId) === subId) {
      this.turnToSub.delete(sub.turnId)
    }
  }

  /** Bump the version counter and notify all useSyncExternalStore listeners. */
  private bump(): void {
    this.version += 1
    // Create a new snapshot object so React detects the change
    this.snapshot = {
      subscriptions: new Map(this.subs),
      version: this.version,
    }
    for (const callback of this.listeners) {
      callback()
    }
  }
}
