import type { DevMode } from "./dev-mode";

/** Host suffixes (`portless run --name …` applies worktree prefix in linked worktrees). */
const SERVICE_HOST_SUFFIXES = {
  server: "server.meridian.localhost",
  app: "app.meridian.localhost",
  www: "web.meridian.localhost",
} as const;

const DEFAULT_EXPECTED_SERVICE_HOSTS = {
  server: SERVICE_HOST_SUFFIXES.server,
  app: SERVICE_HOST_SUFFIXES.app,
  www: SERVICE_HOST_SUFFIXES.www,
} as const;

export type ExpectedServiceName = keyof typeof DEFAULT_EXPECTED_SERVICE_HOSTS;

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
  { name: "server", host: DEFAULT_EXPECTED_SERVICE_HOSTS.server, shared: false },
  { name: "app", host: DEFAULT_EXPECTED_SERVICE_HOSTS.app, shared: true },
];

const WWW_EXPECTED_SERVICE: ExpectedServiceDescriptor = {
  name: "www",
  host: DEFAULT_EXPECTED_SERVICE_HOSTS.www,
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
  tailscale: string[];
  funnel: string[];
}

export interface ParsedPortlessList {
  routes: PortlessRoute[];
  rawLines: string[];
}

const ROUTE_LINE_RE = /^https:\/\/(\S+)\s+->\s+.+?(?:\(pid\s+(\d+)\))?(?:\s*\(alias\))?\s*$/i;
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
      const [, host, pidString] = routeMatch;
      const route: PortlessRoute = {
        host,
        url: `https://${host}`,
        raw: line,
        pid: pidString ? Number.parseInt(pidString, 10) : null,
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
  servicePids: Record<string, number>;
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

function expectedServiceHost(service: ExpectedServiceName, worktreePrefix?: string): string {
  const suffix = SERVICE_HOST_SUFFIXES[service];
  return worktreePrefix ? `${worktreePrefix}.${suffix}` : suffix;
}

function readPortlessRoutes(output: string): PortlessRoute[] {
  return parsePortlessListOutput(output).routes;
}

function findRouteForService(
  routes: PortlessRoute[],
  service: { name: string; host: string },
  worktreePrefix?: string,
): PortlessRoute | undefined {
  const expectedHost = isExpectedServiceName(service.name)
    ? expectedServiceHost(service.name, worktreePrefix)
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
}: {
  output: string;
  mode: DevMode;
  worktreePrefix?: string;
}): Partial<Record<ExpectedServiceName, string>> {
  const routes = readPortlessRoutes(output);
  const urls: Partial<Record<ExpectedServiceName, string>> = {};

  for (const service of getExpectedServicesForMode(mode)) {
    const route = findRouteForService(routes, service, worktreePrefix);
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
      { name, host: SERVICE_HOST_SUFFIXES[name] },
      worktreePrefix,
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
}: {
  output: string;
  mode: DevMode;
  expectedServices?: ReadonlyArray<ExpectedServiceDescriptor>;
  worktreePrefix?: string;
}): RouteValidation {
  const errors: string[] = [];
  const servicePids: Record<string, number> = {};
  const routes = readPortlessRoutes(output);

  for (const service of expectedServices) {
    const route = findRouteForService(routes, service, worktreePrefix);

    if (!route) {
      const hostHint = isExpectedServiceName(service.name)
        ? expectedServiceHost(service.name, worktreePrefix)
        : service.host;
      errors.push(`missing route for ${service.name} (${hostHint})`);
      continue;
    }

    if (route.pid == null) {
      errors.push(`missing route pid for ${service.name} (${route.host})`);
      continue;
    }

    servicePids[service.name] = route.pid;
  }

  return {
    ok: errors.length === 0,
    errors,
    servicePids,
  };
}
