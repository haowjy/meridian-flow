/**
 * ws-thread-socket-utils — small pure helpers for WebSocket close handling:
 * the default ping timeout, terminal-close detection (auth codes), and
 * human-readable close-reason formatting. Shared by the WS transports.
 */
import { WS_CLOSE } from "@meridian/contracts/protocol";

export const DEFAULT_WS_PING_TIMEOUT_MS = 45_000;

export function isTerminalWsClose(event: CloseEvent): boolean {
  return event.code === WS_CLOSE.AUTH_FAILED.code || event.code === WS_CLOSE.PERMISSION_DENIED.code;
}

export function formatWsCloseReason(event: CloseEvent): string {
  const reason = event.reason?.trim();
  if (!reason) return `WebSocket closed (${event.code})`;
  return `WebSocket closed (${event.code}): ${reason}`;
}
