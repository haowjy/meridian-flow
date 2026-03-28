/**
 * In-memory collab relay for Storybook demos.
 *
 * Each peer gets its own Y.Doc (matching the real architecture where
 * every client has an independent Y.Doc synced via WebSocket). The
 * SimulatedServer acts as the central relay, maintaining an authoritative
 * server-side Y.Doc and broadcasting updates between peers.
 *
 * Features:
 * - Per-peer Y.Doc isolation (NOT a shared Y.Doc)
 * - Configurable latency (0ms, 50ms, 200ms, 500ms, 2000ms)
 * - Per-peer disconnect/reconnect with queued update flush
 * - Awareness relay (suppressed from disconnected peers)
 * - Bidirectional reconnect sync (outbound + inbound + state vector diff + awareness)
 */

import * as awarenessProtocol from "y-protocols/awareness"
import { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"

export interface PeerState {
  ydoc: Y.Doc
  awareness: Awareness
  connected: boolean
  pendingInbound: Uint8Array[]
  pendingOutbound: Uint8Array[]
}

export class SimulatedServer {
  private serverDoc = new Y.Doc()
  private peers = new Map<string, PeerState>()
  private latencyMs = 0

  /** All pending timer IDs for cleanup */
  private timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(initialContent?: string) {
    if (initialContent) {
      this.serverDoc.getText("content").insert(0, initialContent)
    }
  }

  setLatency(ms: number): void {
    this.latencyMs = ms
  }

  getLatency(): number {
    return this.latencyMs
  }

  isPeerConnected(peerId: string): boolean {
    return this.peers.get(peerId)?.connected ?? false
  }

  /**
   * Register a peer with the server.
   *
   * Syncs initial state from the server doc to the peer's Y.Doc,
   * then sets up update and awareness listeners.
   */
  addPeer(peerId: string, ydoc: Y.Doc, awareness: Awareness): void {
    // Sync initial state: full server doc -> new peer
    const initialUpdate = Y.encodeStateAsUpdate(this.serverDoc)
    Y.applyUpdate(ydoc, initialUpdate, "remote")

    this.peers.set(peerId, {
      ydoc,
      awareness,
      connected: true,
      pendingInbound: [],
      pendingOutbound: [],
    })

    // Listen for doc updates from this peer
    ydoc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return // don't echo remote updates
      const peer = this.peers.get(peerId)
      if (!peer) return
      if (!peer.connected) {
        // Queue outbound updates while disconnected
        peer.pendingOutbound.push(update)
        return
      }
      // Apply to server doc first, then broadcast to other peers
      Y.applyUpdate(this.serverDoc, update, "remote")
      this.broadcastUpdate(peerId, update)
    })

    // Listen for awareness updates from this peer
    awareness.on(
      "update",
      ({
        added,
        updated,
        removed,
      }: {
        added: number[]
        updated: number[]
        removed: number[]
      }) => {
        const peer = this.peers.get(peerId)
        if (!peer?.connected) return
        const changedClients = [...added, ...updated, ...removed]
        this.broadcastAwareness(peerId, awareness, changedClients)
      },
    )
  }

  /** Remove a peer and clean up listeners */
  removePeer(peerId: string): void {
    this.peers.delete(peerId)
  }

  disconnect(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (peer) peer.connected = false
  }

  /**
   * Reconnect a peer with full bidirectional sync.
   *
   * Steps:
   * 1. Flush outbound: apply this peer's offline edits to server + broadcast
   * 2. Flush inbound: deliver queued updates from other peers
   * 3. State vector diff: catch any missed updates as safety net
   * 4. Awareness re-sync: exchange cursor positions with all connected peers
   */
  reconnect(peerId: string): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    peer.connected = true

    // 1. Flush outbound: apply this peer's offline edits to server + broadcast
    for (const update of peer.pendingOutbound) {
      Y.applyUpdate(this.serverDoc, update, "remote")
      this.broadcastUpdate(peerId, update)
    }
    peer.pendingOutbound = []

    // 2. Flush inbound: apply queued updates from other peers to this peer
    for (const update of peer.pendingInbound) {
      this.deliverWithLatency(() => {
        Y.applyUpdate(peer.ydoc, update, "remote")
      })
    }
    peer.pendingInbound = []

    // 3. Full state sync as safety net (handles any missed updates)
    const fullUpdate = Y.encodeStateAsUpdate(
      this.serverDoc,
      Y.encodeStateVector(peer.ydoc),
    )
    if (fullUpdate.byteLength > 0) {
      this.deliverWithLatency(() => {
        Y.applyUpdate(peer.ydoc, fullUpdate, "remote")
      })
    }

    // 4. Sync awareness state for all connected peers
    for (const [otherId, otherPeer] of this.peers) {
      if (otherId === peerId || !otherPeer.connected) continue
      // Send other peers' awareness to reconnecting peer
      const clients = Array.from(otherPeer.awareness.getStates().keys())
      if (clients.length === 0) continue
      const encoded = awarenessProtocol.encodeAwarenessUpdate(
        otherPeer.awareness,
        clients,
      )
      awarenessProtocol.applyAwarenessUpdate(peer.awareness, encoded, "remote")
    }
  }

  /** Clean up all timers */
  destroy(): void {
    for (const timer of this.timers) {
      clearTimeout(timer)
    }
    this.timers.clear()
    this.serverDoc.destroy()
  }

  // --- Private ---

  private broadcastUpdate(fromPeerId: string, update: Uint8Array): void {
    for (const [peerId, peer] of this.peers) {
      if (peerId === fromPeerId) continue
      if (!peer.connected) {
        peer.pendingInbound.push(update)
        continue
      }
      this.deliverWithLatency(() => {
        Y.applyUpdate(peer.ydoc, update, "remote")
      })
    }
  }

  private broadcastAwareness(
    fromPeerId: string,
    sourceAwareness: Awareness,
    changedClients: number[],
  ): void {
    if (changedClients.length === 0) return
    const encoded = awarenessProtocol.encodeAwarenessUpdate(
      sourceAwareness,
      changedClients,
    )
    for (const [peerId, peer] of this.peers) {
      if (peerId === fromPeerId) continue
      if (!peer.connected) continue
      this.deliverWithLatency(() => {
        awarenessProtocol.applyAwarenessUpdate(
          peer.awareness,
          encoded,
          "remote",
        )
      })
    }
  }

  private deliverWithLatency(fn: () => void): void {
    if (this.latencyMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        fn()
      }, this.latencyMs)
      this.timers.add(timer)
    } else {
      fn()
    }
  }
}
