/**
 * Shared types for the document session module.
 *
 * These types define the document lifecycle states, sync tracking,
 * and transport contracts used by DocSession and SessionPool.
 */

import type * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"
import type { DocStreamClient } from "@/lib/ws/doc-stream-client"

// ---------------------------------------------------------------------------
// Document state types
// ---------------------------------------------------------------------------

/** Reason a session was frozen — prevents further local edits. */
export type FrozenReason = "document-deleted" | "access-revoked"

/**
 * Coarse connectivity-facing sync state for UI indicators.
 *
 * - connected: WS is open and updates are flowing (not a durability guarantee)
 * - local-changes-pending: local edits exist that can't be sent (offline/reconnecting)
 * - disconnected: no active WS and no known unsent local edits
 */
export type DocSyncState =
  | "connected"
  | "local-changes-pending"
  | "disconnected"

/**
 * WebSocket connection state machine.
 *
 * See design doc "Connection state machine" diagram for transitions.
 * document:restored triggers resetting; AUTH_EXPIRED triggers reconnecting.
 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "resetting"

// ---------------------------------------------------------------------------
// WebSocket provider contracts (Phase 4 implementation)
// ---------------------------------------------------------------------------

export type ProviderControlEvent =
  | { type: "connected" }
  | { type: "auth-expired" }
  | { type: "access-revoked"; status: 403 | 404 }
  | { type: "document-restored" }
  | { type: "rate-limited"; retryAfterMs?: number }
  | { type: "fatal"; code: string; message: string }

export interface DocumentWsProvider {
  connect(): void
  disconnect(reason?: string): void
  sendAwarenessUpdate(update: Uint8Array): void
  onConnectionState(listener: (state: ConnectionState) => void): () => void
  onControlEvent(listener: (event: ProviderControlEvent) => void): () => void
  destroy(): void
}

/**
 * Factory for creating WS providers — injected by SessionPool.
 *
 * Decouples DocSession from transport construction so the pool
 * can control auth, reconnection policy, and provider lifecycle.
 *
 * Uses DocStreamClient instead of getAccessToken — auth is handled
 * at the connection level by DocWsProvider, not per-document.
 */
export type DocumentWsProviderFactory = (args: {
  documentId: string
  ydoc: Y.Doc
  awareness: Awareness
  docStreamClient: DocStreamClient
}) => DocumentWsProvider
