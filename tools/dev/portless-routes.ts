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

function isExpectedServiceName(name: string): name is ExpectedServiceName {
  return name === "server" || name === "app" || name === "www";
}

export type ExpectedServiceDescriptor = {
  name: ExpectedServiceName;
  host: string;
  /** When true, tailscale/funnel mode requires an external share line for this service. */
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

/** Labeled full URLs for copy-paste; infra: `pnpm portless:list`. */
export function formatDevRouteLines(
  output: string,
  mode: DevMode,
  worktreePrefix?: string,
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

    if (mode === "tailscale" && route.tailscale[0]) {
      pushRouteLine(lines, name, "ts", route.tailscale[0]);
    }

    if (mode === "funnel" && route.funnel[0]) {
      pushRouteLine(lines, name, "funnel", route.funnel[0]);
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

    if (mode === "tailscale" && service.shared && route.tailscale.length === 0) {
      errors.push(`missing tailscale share for ${service.name} (${route.host})`);
    }

    if (mode === "funnel" && service.shared && route.funnel.length === 0) {
      errors.push(`missing funnel share for ${service.name} (${route.host})`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    servicePids,
  };
}
