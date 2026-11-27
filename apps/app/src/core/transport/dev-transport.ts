export type BrowserLocationLike = {
  protocol: string;
  hostname: string;
  port: string;
  host: string;
};

/**
 * WS path duplicated from @meridian/contracts/protocol to avoid pulling contracts
 * into the vite.config.ts import chain — Node's native ESM loader can't resolve
 * .ts sources in workspace packages during config bootstrap.
 */
const THREADS_WS_PATH = "/api/threads/ws";

export function buildThreadsWsUrl(location: BrowserLocationLike = window.location): string {
  return buildSameOriginWsUrl(THREADS_WS_PATH, location);
}

export function buildSameOriginWsUrl(
  path: string,
  location: BrowserLocationLike = window.location,
): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}${path}`;
}
