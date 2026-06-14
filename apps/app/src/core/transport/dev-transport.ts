// @ts-nocheck
/**
 * dev-transport — resolves the server origin and WebSocket URLs for the dev
 * portless environment.
 *
 * Maps the app's `*.app.meridian.localhost` / `ts.net` host to its paired server
 * origin and builds same-origin/threads WS URLs (worktree-aware). Pure URL
 * resolution; shared by both transports. No socket logic of its own.
 */
const APP_HOST_SUFFIX = ".app.meridian.localhost";
const BARE_APP_HOST = "app.meridian.localhost";
const BARE_SERVER_HOST = "server.meridian.localhost";
const TS_NET_SUFFIX = ".ts.net";

export type BrowserLocationLike = {
  protocol: string;
  hostname: string;
  port: string;
  host: string;
};

/** Build the localhost server origin the vite proxy forwards to. Worktree-aware. */
export function resolveApiDevOriginFallback(worktreePrefix?: string): string {
  return worktreePrefix
    ? `https://${worktreePrefix}.${BARE_SERVER_HOST}`
    : `https://${BARE_SERVER_HOST}`;
}

/** Map app portless host to paired server origin (https). Falls back when host is unknown. */
export function resolveApiDevOriginForAppHost(appHost: string, fallback: string): string {
  const [rawHost] = appHost.toLowerCase().split(":");
  const host = rawHost ?? "";
  if (!host || host === BARE_APP_HOST) {
    return fallback;
  }

  if (host.endsWith(APP_HOST_SUFFIX)) {
    const prefix = host.slice(0, host.length - APP_HOST_SUFFIX.length);
    if (!prefix) {
      return fallback;
    }
    return `https://${prefix}.${BARE_SERVER_HOST}`;
  }

  if (host.endsWith(TS_NET_SUFFIX)) {
    return fallback;
  }

  return fallback;
}

/**
 * WS path duplicated from @meridian/contracts/protocol to avoid pulling contracts
 * into the vite.config.ts import chain — Node's native ESM loader can't resolve
 * .ts sources in workspace packages during config bootstrap.
 */
const THREADS_WS_PATH = "/api/threads/ws";

/**
 * WebSocket URL for thread events — always same-origin as the app page.
 *
 * Portless assigns dynamic ts.net ports per worktree/mode; the browser must not
 * hardcode an API port. Vite `server.proxy` upgrades `/api/threads/ws` to the
 * paired server origin (`resolveApiDevOriginForAppHost` / `MERIDIAN_API_ORIGIN`).
 */
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
