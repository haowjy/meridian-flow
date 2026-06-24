/** Helpers for pruning dead-target Tailscale serve/funnel routes. */
export type TailscaleRouteMode = "serve" | "funnel";

export interface TailscaleRouteBinding {
  mode: TailscaleRouteMode;
  httpsPort: number;
  localPort: number;
}

export interface TailscaleRouteToPrune {
  mode: TailscaleRouteMode;
  httpsPort: number;
}

export type PortLivenessProbe = (port: number) => boolean;

type JsonObject = Record<string, unknown>;

const LOCAL_PROXY_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|::1):(\d+)(?:[/?#].*)?$/i;
const HTTPS_PORT_RE = /(?:^|:)(\d+)$/;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePort(value: string | number | undefined): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;

  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function httpsPortFromKey(key: string): number | null {
  return parsePort(HTTPS_PORT_RE.exec(key)?.[1]);
}

function localPortFromProxy(value: unknown): number | null {
  if (typeof value !== "string") return null;
  return parsePort(LOCAL_PROXY_RE.exec(value)?.[1]);
}

function collectFunnelPorts(value: unknown, ports = new Set<number>()): Set<number> {
  if (!isObject(value)) return ports;

  for (const [key, child] of Object.entries(value)) {
    if (key === "AllowFunnel" || key === "Funnel" || key === "Funnels") {
      collectTruthyPortKeys(child, ports);
      continue;
    }

    collectFunnelPorts(child, ports);
  }

  return ports;
}

function collectTruthyPortKeys(value: unknown, ports: Set<number>): void {
  if (!isObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const port = httpsPortFromKey(key);
    if (port && child) {
      ports.add(port);
    }

    if (isObject(child)) {
      collectTruthyPortKeys(child, ports);
    }
  }
}

function collectWebBindings(
  value: unknown,
  funnelPorts: ReadonlySet<number>,
  bindings: TailscaleRouteBinding[] = [],
): TailscaleRouteBinding[] {
  if (!isObject(value)) return bindings;

  for (const [key, child] of Object.entries(value)) {
    const httpsPort = httpsPortFromKey(key);
    if (httpsPort && isObject(child)) {
      collectHandlerBindings(child, httpsPort, funnelPorts, bindings);
    }

    collectWebBindings(child, funnelPorts, bindings);
  }

  return bindings;
}

function collectHandlerBindings(
  value: unknown,
  httpsPort: number,
  funnelPorts: ReadonlySet<number>,
  bindings: TailscaleRouteBinding[],
): void {
  if (!isObject(value)) return;

  const localPort = localPortFromProxy(value.Proxy);
  if (localPort) {
    bindings.push({
      mode: funnelPorts.has(httpsPort) ? "funnel" : "serve",
      httpsPort,
      localPort,
    });
  }

  for (const child of Object.values(value)) {
    collectHandlerBindings(child, httpsPort, funnelPorts, bindings);
  }
}

function routeKey(route: Pick<TailscaleRouteBinding, "mode" | "httpsPort">): string {
  return `${route.mode}:${route.httpsPort}`;
}

/** Extracts localhost proxy routes from `tailscale serve status --json`-style output. */
export function parseTailscaleServeStatusJson(json: unknown): TailscaleRouteBinding[] {
  const funnelPorts = collectFunnelPorts(json);
  const bindings = collectWebBindings(json, funnelPorts);
  const seen = new Set<string>();

  return bindings.filter((binding) => {
    const key = `${routeKey(binding)}:${binding.localPort}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Pure pruning policy: only dead localhost targets are eligible, live targets are never touched. */
export function findStaleTailscaleRoutes(
  bindings: ReadonlyArray<TailscaleRouteBinding>,
  isPortLive: PortLivenessProbe,
): TailscaleRouteToPrune[] {
  const grouped = new Map<string, { route: TailscaleRouteToPrune; localPorts: number[] }>();

  for (const binding of bindings) {
    const route = {
      mode: binding.mode,
      httpsPort: binding.httpsPort,
    } satisfies TailscaleRouteToPrune;
    const key = routeKey(route);
    const group = grouped.get(key);

    if (group) {
      group.localPorts.push(binding.localPort);
    } else {
      grouped.set(key, { route, localPorts: [binding.localPort] });
    }
  }

  return [...grouped.values()]
    .filter(({ localPorts }) => localPorts.every((port) => !isPortLive(port)))
    .map(({ route }) => route);
}

/** Surgical per-port command only; never produces a global Tailscale reset. */
export function tailscaleRouteOffArgs(route: TailscaleRouteToPrune): string[] {
  return [route.mode, `--https=${route.httpsPort}`, "off"];
}
