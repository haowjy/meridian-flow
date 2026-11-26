export type BrowserLocationLike = {
  protocol: string;
  hostname: string;
  port: string;
  host: string;
};

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
