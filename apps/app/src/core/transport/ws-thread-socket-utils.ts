// @ts-nocheck
/**
 * ws-thread-socket-utils — small pure helpers for WebSocket close handling:
 * the default ping timeout, terminal-close detection (auth codes), and
 * human-readable close-reason formatting. Shared by the WS transports.
 */
export const DEFAULT_WS_PING_TIMEOUT_MS = 45_000;

export function isTerminalWsClose(event: CloseEvent): boolean {
  return event.code === 4401 || event.code === 4403;
}

export function formatWsCloseReason(event: CloseEvent): string {
  const reason = event.reason?.trim();
  if (!reason) return `WebSocket closed (${event.code})`;
  return `WebSocket closed (${event.code}): ${reason}`;
}
