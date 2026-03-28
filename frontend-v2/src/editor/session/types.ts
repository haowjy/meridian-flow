/**
 * Shared types for the document session module.
 *
 * These types define the document lifecycle states, sync tracking,
 * and transport contracts used by DocSession and SessionPool.
 */

import type * as Y from "yjs"

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

/**
 * Placeholder interface for the WebSocket provider.
 *
 * The real implementation (Phase 4) handles binary Yjs sync,
 * awareness relay, heartbeat, auth refresh, and control-plane events.
 */
export interface DocumentWsProvider {
  connect(): void
  disconnect(): void
  destroy(): void
}

/**
 * Factory for creating WS providers — injected by SessionPool.
 *
 * Decouples DocSession from transport construction so the pool
 * can control auth, reconnection policy, and provider lifecycle.
 */
export type DocumentWsProviderFactory = (
  documentId: string,
  ydoc: Y.Doc,
) => DocumentWsProvider
