import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DevMode } from "./dev-mode";

/** Portless's default HTTPS proxy port. Its URLs omit this port. */
const DEFAULT_PROXY_PORT = 443;

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/**
 * The port Portless's proxy is using. `portless list` renders URLs from the
 * running proxy's `proxy.port`, so that file wins over `PORTLESS_PORT`, which
 * only asks a new proxy to start on a port.
 */
export function resolvePortlessProxyPort(env: NodeJS.ProcessEnv = process.env): number {
  const stateDir = env.PORTLESS_STATE_DIR ?? path.join(os.homedir(), ".portless");
  try {
    const recorded = Number.parseInt(
      fs.readFileSync(path.join(stateDir, "proxy.port"), "utf8").trim(),
      10,
    );
    if (isPort(recorded)) return recorded;
  } catch {
    // A missing state file means the proxy has not run yet; fall through.
  }

  const requested = Number.parseInt(env.PORTLESS_PORT ?? "", 10);
  return isPort(requested) ? requested : DEFAULT_PROXY_PORT;
}

/** Canonical names used by command rendering, route checks and internal origins. */
const SERVICE_PORTLESS_NAMES = {
  server: "server.meridian",
  app: "app.meridian",
  www: "web.meridian",
} as const;

export type ExpectedServiceName = keyof typeof SERVICE_PORTLESS_NAMES;

export interface ExternalDevRoute {
  service: ExpectedServiceName;
  mode: "serve" | "funnel";
  httpsPort: number;
  url?: string;
}

function isExpectedServiceName(name: string): name is ExpectedServiceName {
  return name === "server" || name === "app" || name === "www";
}

export type ExpectedServiceDescriptor = {
  name: ExpectedServiceName;
  host: string;
  /** When true, tools/dev exposes the service through Tailscale/funnel in shared modes. */
  shared: boolean;
};

export const DEFAULT_EXPECTED_SERVICES: ReadonlyArray<ExpectedServiceDescriptor> = [
  { name: "server", host: expectedServiceHost("server"), shared: false },
  { name: "app", host: expectedServiceHost("app"), shared: true },
];

const WWW_EXPECTED_SERVICE: ExpectedServiceDescriptor = {
  name: "www",
  host: expectedServiceHost("www"),
  shared: true,
};

/** Core app+server always; www when dev-tmux explicitly starts @meridian/www (tailscale/funnel). */
export function getExpectedServicesForMode(
  mode: DevMode,
): ReadonlyArray<ExpectedServiceDescriptor> {
  if (mode === "local") {
    return DEFAULT_EXPECTED_SERVICES;
  }

  return [...DEFAULT_EXPECTED_SERVICES, WWW_EXPECTED_SERVICE];
}

export interface PortlessRoute {
  host: string;
  url: string;
  raw: string;
  pid: number | null;
  port: number;
  tailscale: string[];
  funnel: string[];
}

export interface ParsedPortlessList {
  routes: PortlessRoute[];
  rawLines: string[];
}

const ROUTE_LINE_RE =
  /^https:\/\/([^\s:]+)(?::(\d+))?\s+->\s+(?:http:\/\/)?[^\s:]+:(\d+)(?:\s+\(pid\s+(\d+)\))?(?:\s*\(alias\))?(?:\s+up\s+\S+)?\s*$/i;
const SHARE_LINE_RE = /^(tailscale|funnel):\s*(.+)$/i;

export function parsePortlessListOutput(output: string): ParsedPortlessList {
  const rawLines: string[] = [];
  const routes: PortlessRoute[] = [];
  let currentRoute: PortlessRoute | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const routeMatch = ROUTE_LINE_RE.exec(line);
    if (routeMatch) {
      rawLines.push(line);
      const [, hostname, proxyPortString, portString, pidString] = routeMatch;
      const host = proxyPortString ? `${hostname}:${proxyPortString}` : hostname;
      const route: PortlessRoute = {
        host,
        url: `https://${host}`,
        raw: line,
        pid: pidString ? Number.parseInt(pidString, 10) : null,
        port: Number(portString),
        tailscale: [],
        funnel: [],
      };
      routes.push(route);
      currentRoute = route;
      continue;
    }

    const shareMatch = SHARE_LINE_RE.exec(line);
    if (shareMatch && currentRoute) {
      rawLines.push(line);
      const [, shareType, shareValue] = shareMatch;
      if (shareType.toLowerCase() === "tailscale") {
        currentRoute.tailscale.push(shareValue.trim());
      } else {
        currentRoute.funnel.push(shareValue.trim());
      }
    }
  }

  return { routes, rawLines };
}

export interface RouteValidation {
  ok: boolean;
  errors: string[];
}

/** app/www first — matches how people scan startup output. */
const SERVICE_DISPLAY_ORDER: ExpectedServiceName[] = ["app", "www", "server"];

const ROUTE_KIND_WIDTH = 6;

function pushRouteLine(
  lines: string[],
  service: ExpectedServiceName,
  kind: string,
  url: string,
): void {
  lines.push(`${service}  ${kind.padEnd(ROUTE_KIND_WIDTH)} ${url}`);
}

export function expectedPortlessName(
  service: ExpectedServiceName,
  worktreePrefix?: string,
): string {
  const name = SERVICE_PORTLESS_NAMES[service];
  return worktreePrefix ? `${worktreePrefix}.${name}` : name;
}

export function expectedServiceHost(
  service: ExpectedServiceName,
  worktreePrefix?: string,
  proxyPort: number = DEFAULT_PROXY_PORT,
): string {
  const host = `${expectedPortlessName(service, worktreePrefix)}.localhost`;
  return proxyPort === DEFAULT_PROXY_PORT ? host : `${host}:${proxyPort}`;
}

export function expectedServiceOrigin(
  service: ExpectedServiceName,
  worktreePrefix?: string,
  proxyPort: number = DEFAULT_PROXY_PORT,
): string {
  return `https://${expectedServiceHost(service, worktreePrefix, proxyPort)}`;
}

function readPortlessRoutes(output: string): PortlessRoute[] {
  return parsePortlessListOutput(output).routes;
}

function findRouteForService(
  routes: PortlessRoute[],
  service: { name: string; host: string },
  worktreePrefix: string | undefined,
  proxyPort: number,
): PortlessRoute | undefined {
  const expectedHost = isExpectedServiceName(service.name)
    ? expectedServiceHost(service.name, worktreePrefix, proxyPort)
    : service.host;

  return routes.find((route) => route.host === expectedHost);
}

function externalRouteForService(
  routes: ReadonlyArray<ExternalDevRoute>,
  service: ExpectedServiceName,
  mode: DevMode,
): ExternalDevRoute | undefined {
  const routeMode = mode === "funnel" ? "funnel" : "serve";
  return routes.find((route) => route.service === service && route.mode === routeMode);
}

function externalRouteUrl(route: ExternalDevRoute): string {
  return route.url ?? `https://<tailscale-node>:${route.httpsPort}`;
}

export function resolveExpectedRouteUrls({
  output,
  mode,
  worktreePrefix,
  proxyPort = DEFAULT_PROXY_PORT,
}: {
  output: string;
  mode: DevMode;
  worktreePrefix?: string;
  proxyPort?: number;
}): Partial<Record<ExpectedServiceName, string>> {
  const routes = readPortlessRoutes(output);
  const urls: Partial<Record<ExpectedServiceName, string>> = {};

  for (const service of getExpectedServicesForMode(mode)) {
    const route = findRouteForService(routes, service, worktreePrefix, proxyPort);
    if (route) urls[service.name] = route.url;
  }

  return urls;
}

/** Labeled full URLs for copy-paste; infra: `pnpm portless:list`. */
export function formatDevRouteLines(
  output: string,
  mode: DevMode,
  worktreePrefix?: string,
  externalRoutes: ReadonlyArray<ExternalDevRoute> = [],
  proxyPort: number = DEFAULT_PROXY_PORT,
): string[] {
  const expected = new Set(getExpectedServicesForMode(mode).map((service) => service.name));
  const routes = readPortlessRoutes(output);
  const lines: string[] = [];

  for (const name of SERVICE_DISPLAY_ORDER) {
    if (!expected.has(name)) {
      continue;
    }

    const route = findRouteForService(
      routes,
      { name, host: expectedServiceHost(name) },
      worktreePrefix,
      proxyPort,
    );
    if (!route) {
      continue;
    }

    if (mode === "local") {
      pushRouteLine(lines, name, "local", route.url);
      continue;
    }

    pushRouteLine(lines, name, "local", route.url);

    const externalRoute = externalRouteForService(externalRoutes, name, mode);
    if (mode === "tailscale" && externalRoute) {
      pushRouteLine(lines, name, "ts", externalRouteUrl(externalRoute));
    }

    if (mode === "funnel" && externalRoute) {
      pushRouteLine(lines, name, "funnel", externalRouteUrl(externalRoute));
    }
  }

  return lines;
}

export function validateExpectedRoutes({
  output,
  mode,
  expectedServices = getExpectedServicesForMode(mode),
  worktreePrefix,
  proxyPort = DEFAULT_PROXY_PORT,
  expectedPorts = {},
  ownsPid,
}: {
  output: string;
  mode: DevMode;
  expectedServices?: ReadonlyArray<ExpectedServiceDescriptor>;
  worktreePrefix?: string;
  proxyPort?: number;
  expectedPorts?: Partial<Record<ExpectedServiceName, number>>;
  ownsPid?: (pid: number) => boolean;
}): RouteValidation {
  const errors: string[] = [];
  const routes = readPortlessRoutes(output);

  for (const service of expectedServices) {
    const route = findRouteForService(routes, service, worktreePrefix, proxyPort);

    if (!route) {
      const hostHint = isExpectedServiceName(service.name)
        ? expectedServiceHost(service.name, worktreePrefix, proxyPort)
        : service.host;
      errors.push(`missing route for ${service.name} (${hostHint})`);
      continue;
    }

    if (route.pid == null || route.pid <= 0) {
      errors.push(`missing route pid for ${service.name} (${route.host})`);
      continue;
    }

    if (ownsPid && !ownsPid(route.pid)) {
      errors.push(`foreign or uninspectable route owner for ${route.host} (PID ${route.pid})`);
      continue;
    }
    const expectedPort = expectedPorts[service.name];
    if (expectedPort !== undefined && route.port !== expectedPort) {
      errors.push(`wrong backend for ${route.host}: port ${route.port}, expected ${expectedPort}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
