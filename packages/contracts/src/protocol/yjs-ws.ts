/**
 * Purpose: Defines the Yjs WebSocket path used by collaborative document sync clients and server handlers.
 * Why independent: Path constants are wire-protocol primitives shared across the frontend editor and server WebSocket adapter.
 */
export const YJS_WS_PATH_PREFIX = "/ws/yjs";

export function yjsWsPath(): string {
  return YJS_WS_PATH_PREFIX;
}
