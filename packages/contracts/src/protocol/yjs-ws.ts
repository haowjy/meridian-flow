/**
 * Purpose: Defines Yjs WebSocket path and message-type constants used by collaborative document sync clients and server handlers.
 * Why independent: These values are wire-protocol primitives shared across the frontend editor and server WebSocket adapter.
 */
export const YJS_WS_PATH_PREFIX = "/ws/yjs";

export const YJS_WS_MESSAGE_SYNC = 0;
export const YJS_WS_MESSAGE_AWARENESS = 1;

export function yjsWsPath(): string {
  return YJS_WS_PATH_PREFIX;
}
