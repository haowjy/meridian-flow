// ═══════════════════════════════════════════════════════════════════
// Wire protocol types — TypeScript mirror of the generic WS envelope.
//
// Every WS message (both directions) is a JSON text frame using this
// shape. The `kind` field discriminates four lanes: control, notify,
// stream, error. See protocol.md for the full spec.
// ═══════════════════════════════════════════════════════════════════

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Lane discriminator — determines which handler receives the message. */
export type EnvelopeKind = "control" | "notify" | "stream" | "error"

/** Resource target for messages scoped to a specific entity. */
export interface EnvelopeResource {
  type: string
  id: string
}

/**
 * Generic wire envelope. Every WS message uses this shape.
 *
 * Only `kind` and `op` are always present. Other fields are
 * lane-specific — see per-lane constants below.
 */
export interface Envelope {
  kind: EnvelopeKind
  op: string
  resource?: EnvelopeResource
  subId?: string
  seq?: number
  epoch?: string
  payload?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Control lane ops
// ---------------------------------------------------------------------------

/** Client → server control ops. */
export const CONTROL_OP = {
  AUTH: "auth",
  PONG: "pong",
  SUBSCRIBE: "subscribe",
  UNSUBSCRIBE: "unsubscribe",
} as const

/** Server → client control ops. */
export const CONTROL_RESPONSE_OP = {
  CONNECTED: "connected",
  PING: "ping",
  SUBSCRIBED: "subscribed",
  UNSUBSCRIBED: "unsubscribed",
} as const

// ---------------------------------------------------------------------------
// Notify lane ops
// ---------------------------------------------------------------------------

export const NOTIFY_OP = {
  INVALIDATE: "invalidate",
} as const

// ---------------------------------------------------------------------------
// Stream lane ops
// ---------------------------------------------------------------------------

/** Server → client stream ops. */
export const STREAM_OP = {
  EVENT: "event",
  ENDED: "ended",
  GAP: "gap",
} as const

/** Client → server stream ops. */
export const STREAM_CLIENT_OP = {
  MESSAGE: "message",
} as const

// ---------------------------------------------------------------------------
// Error lane ops
// ---------------------------------------------------------------------------

export const ERROR_OP = {
  ERROR: "error",
} as const

/** Well-known error codes from the server. */
export const ERROR_CODE = {
  SUBSCRIBE_FAILED: "SUBSCRIBE_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  AUTH_FAILED: "AUTH_FAILED",
  INVALID_MESSAGE: "INVALID_MESSAGE",
} as const

// ---------------------------------------------------------------------------
// Notify event names (payload.event values)
// ---------------------------------------------------------------------------

export const NOTIFY_EVENT = {
  COMPLETED: "completed",
  ERROR: "error",
  CANCELLED: "cancelled",
  SPAWN_STARTED: "spawn_started",
  UPDATED: "updated",
  CREATED: "created",
} as const

// ---------------------------------------------------------------------------
// Resource types used in notify/stream messages
// ---------------------------------------------------------------------------

export const RESOURCE_TYPE = {
  TURN: "turn",
  THREAD: "thread",
  DOCUMENT: "document",
  PROPOSAL: "proposal",
} as const

// ---------------------------------------------------------------------------
// Connection state machine
// ---------------------------------------------------------------------------

/**
 * WS connection state machine.
 *
 * Transitions:
 *   disconnected → connecting → connected
 *   connected → reconnecting (on close/error)
 *   reconnecting → connecting (on backoff timer)
 *   any → disconnected (on explicit disconnect)
 */
export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a raw WS text frame into an Envelope. Returns null if the
 * frame is not valid JSON or missing the required `kind`/`op` fields.
 */
export function parseEnvelope(raw: string): Envelope | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      !("kind" in parsed) ||
      !("op" in parsed) ||
      typeof (parsed as Envelope).kind !== "string" ||
      typeof (parsed as Envelope).op !== "string"
    ) {
      return null
    }
    return parsed as Envelope
  } catch {
    return null
  }
}

/**
 * Build a control envelope. Convenience for client → server messages.
 */
export function controlEnvelope(
  op: string,
  payload?: Record<string, unknown>,
): Envelope {
  return { kind: "control", op, payload }
}
