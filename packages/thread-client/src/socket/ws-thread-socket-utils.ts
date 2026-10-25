/**
 * ws-thread-socket-utils — small pure helpers for WebSocket close handling:
 * the default ping timeout, terminal-close detection (auth codes), and
 * human-readable close-reason formatting. Shared by the WS transports.
 */
import { WS_CLOSE } from "@meridian/contracts/protocol";

import type { SocketClose } from "./socket-ports";

export const DEFAULT_WS_PING_TIMEOUT_MS = 45_000;

/**
 * One replay request's bound, from its send to its outcome. A backstop for a
 * request the server never answers; pings do not reset it. The slowest
 * legitimate case measured (five 50k-row threads on a cold hub) took 2 s.
 */
export const DEFAULT_WS_REPLAY_DEADLINE_MS = 20_000;

/**
 * One `ask.answer` request's bound, from its send to its reply. Pings do not reset it. Expiry is
 * `unconfirmed`: the answer may have landed, and a Retry under the same submission id is safe.
 */
export const DEFAULT_WS_ASK_ANSWER_DEADLINE_MS = 20_000;

export function isTerminalWsClose(event: SocketClose): boolean {
  return event.code === WS_CLOSE.AUTH_FAILED.code || event.code === WS_CLOSE.PERMISSION_DENIED.code;
}

export function formatWsCloseReason(event: SocketClose): string {
  const reason = event.reason?.trim();
  if (!reason) return `WebSocket closed (${event.code})`;
  return `WebSocket closed (${event.code}): ${reason}`;
}
