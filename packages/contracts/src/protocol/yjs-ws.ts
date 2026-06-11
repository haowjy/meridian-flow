export const YJS_WS_PATH_PREFIX = "/ws/yjs";

export const YJS_WS_MESSAGE_SYNC = 0;
export const YJS_WS_MESSAGE_AWARENESS = 1;

export function yjsWsPath(): string {
  return YJS_WS_PATH_PREFIX;
}
