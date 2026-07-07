import { resolveAppEnvPassthroughKeys } from "./dev-app-env-passthrough";
import type { DevMode } from "./dev-mode";
import { resolveDevRuntimeEnvPassthroughKeys } from "./lib/dev-env";
import type { SharedDevServiceName, SharedDevServicePorts } from "./lib/dev-share-ports";
import type { ExpectedServiceName, ExternalDevRoute } from "./portless-routes";

const logPath = "logs/portless.log";

export interface DevSessionMetadata {
  sessionName: string;
  mode: DevMode;
  branch: string;
  /** Redacted display command only. The executable command may contain secrets and is never persisted. */
  command: string;
  createdAt: string;
  externalRoutes?: ExternalDevRoute[];
}

interface DevServiceSpec {
  serviceName: ExpectedServiceName;
  portlessName: string;
  pkg: string;
  shared: boolean;
  sharedModeOnly?: boolean;
}

export interface DevSessionCommand {
  executable: string;
  display: string;
  internalApiOrigin: string;
}

const DEV_SERVICES: ReadonlyArray<DevServiceSpec> = [
  { serviceName: "app", portlessName: "app.meridian", pkg: "@meridian/app", shared: true },
  {
    serviceName: "server",
    portlessName: "server.meridian",
    pkg: "@meridian/server",
    shared: false,
  },
  {
    serviceName: "www",
    portlessName: "web.meridian",
    pkg: "@meridian/www",
    shared: true,
    sharedModeOnly: true,
  },
];

const PORTLESS_ENV_KEYS = [
  "PORTLESS_LAN",
  "PORTLESS_HTTPS",
  "PORTLESS_TLD",
  "PORTLESS_WILDCARD",
  "PORTLESS_SYNC_HOSTS",
  "PORTLESS_STATE_DIR",
] as const;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function databaseNameFromUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return decodeURIComponent(url.pathname.replace(/^\//, "")) || undefined;
  } catch {
    return undefined;
  }
}

export function redactEnvValue(key: string, value: string): string {
  if (key === "DATABASE_URL") {
    try {
      const url = new URL(value);
      const dbName = databaseNameFromUrl(value);
      return dbName ? `<postgres:${url.host}/${dbName}>` : "<postgres:redacted>";
    } catch {
      return "<postgres:redacted>";
    }
  }

  if (
    key === "WORKOS_DEV_LOGIN_EMAIL" ||
    /(_API_KEY|_PASSWORD|_TOKEN|_SECRET|COOKIE_PASSWORD|PRIVATE_KEY)$/i.test(key)
  ) {
    return "<redacted>";
  }

  return value;
}

function envAssignments(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  redacted: boolean,
): string[] {
  return keys
    .filter((key) => env[key] !== undefined)
    .map((key) => {
      const value = env[key] ?? "";
      return `${key}=${shellQuote(redacted ? redactEnvValue(key, value) : value)}`;
    });
}

function portlessEnvPrefix(env: NodeJS.ProcessEnv, redacted: boolean): string {
  const assignments = envAssignments(env, PORTLESS_ENV_KEYS, redacted);
  return assignments.length > 0 ? `env ${assignments.join(" ")} ` : "";
}

function appRuntimeEnv(env: NodeJS.ProcessEnv, internalApiOrigin: string): NodeJS.ProcessEnv {
  return {
    ...env,
    MERIDIAN_API_ORIGIN: internalApiOrigin,
  };
}

function appEnvPassthroughExports(
  env: NodeJS.ProcessEnv,
  internalApiOrigin: string,
  redacted: boolean,
): string {
  const runtimeEnv = appRuntimeEnv(env, internalApiOrigin);
  const keys = resolveAppEnvPassthroughKeys(runtimeEnv);
  const exports = envAssignments(runtimeEnv, keys, redacted).map(
    (assignment) => `export ${assignment}`,
  );

  return exports.length > 0 ? `; ${exports.join("; ")}` : "";
}

function devRuntimeEnvExports(env: NodeJS.ProcessEnv, redacted: boolean): string {
  const keys = resolveDevRuntimeEnvPassthroughKeys(env);
  const exports = envAssignments(env, keys, redacted).map((assignment) => `export ${assignment}`);
  return exports.length > 0 ? `; ${exports.join("; ")}` : "";
}

function envSourcePreamble(
  env: NodeJS.ProcessEnv,
  internalApiOrigin: string,
  redacted: boolean,
): string {
  return `set -a; [ -f .env ] && . ./.env; set +a${appEnvPassthroughExports(
    env,
    internalApiOrigin,
    redacted,
  )}${devRuntimeEnvExports(env, redacted)}`;
}

function sharedPortsByService(
  sharedPorts: ReadonlyArray<SharedDevServicePorts>,
): Map<SharedDevServiceName, SharedDevServicePorts> {
  return new Map(sharedPorts.map((ports) => [ports.service, ports]));
}

function portlessCommandBody({
  mode,
  sharedPorts,
  env,
  redacted,
}: {
  mode: DevMode;
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  env: NodeJS.ProcessEnv;
  redacted: boolean;
}): string {
  const portsByService = sharedPortsByService(sharedPorts);
  const commands = DEV_SERVICES.filter(
    (service) => mode !== "local" || !service.sharedModeOnly,
  ).map(({ serviceName, portlessName, pkg }) => {
    const servicePorts =
      serviceName === "app" || serviceName === "www" ? portsByService.get(serviceName) : undefined;
    const appPortFlag = servicePorts ? ` --app-port ${servicePorts.appBackendPort}` : "";
    return `${portlessEnvPrefix(env, redacted)}pnpm exec portless run --name ${portlessName}${appPortFlag} pnpm --filter ${pkg} dev`;
  });

  return `(${commands.map((command) => `${command} & sleep 2`).join("; ")}; wait)`;
}

function renderPortlessCommand({
  mode,
  sharedPorts,
  env,
  internalApiOrigin,
  redacted,
}: {
  mode: DevMode;
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  env: NodeJS.ProcessEnv;
  internalApiOrigin: string;
  redacted: boolean;
}): string {
  return `mkdir -p logs logs/events && ${envSourcePreamble(
    env,
    internalApiOrigin,
    redacted,
  )} && unset PORTLESS_TAILSCALE PORTLESS_FUNNEL && ${portlessCommandBody({
    mode,
    sharedPorts,
    env,
    redacted,
  })} 2>&1 | tee ${logPath}`;
}

export function resolveInternalApiOrigin(worktreePrefix?: string): string {
  const host = worktreePrefix
    ? `${worktreePrefix}.server.meridian.localhost`
    : "server.meridian.localhost";
  return `https://${host}`;
}

export function createDevSessionCommand({
  mode,
  sharedPorts,
  env = process.env,
  worktreePrefix,
}: {
  mode: DevMode;
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  env?: NodeJS.ProcessEnv;
  worktreePrefix?: string;
}): DevSessionCommand {
  const internalApiOrigin = resolveInternalApiOrigin(worktreePrefix);
  return {
    executable: renderPortlessCommand({
      mode,
      sharedPorts,
      env,
      internalApiOrigin,
      redacted: false,
    }),
    display: renderPortlessCommand({
      mode,
      sharedPorts,
      env,
      internalApiOrigin,
      redacted: true,
    }),
    internalApiOrigin,
  };
}

export function sharedServiceNamesForMode(mode: DevMode): SharedDevServiceName[] {
  if (mode === "local") return [];

  return DEV_SERVICES.filter(
    (service): service is DevServiceSpec & { serviceName: SharedDevServiceName } =>
      service.shared && (service.serviceName === "app" || service.serviceName === "www"),
  )
    .filter((service) => mode !== "local" || !service.sharedModeOnly)
    .map((service) => service.serviceName);
}

export function buildMetadata({
  branch,
  sessionName,
  mode,
  displayCommand,
  externalRoutes = [],
}: {
  branch: string;
  sessionName: string;
  mode: DevMode;
  displayCommand: string;
  externalRoutes?: ExternalDevRoute[];
}): DevSessionMetadata {
  return {
    sessionName,
    mode,
    branch: branch || "detached",
    command: displayCommand,
    createdAt: new Date().toISOString(),
    externalRoutes,
  };
}
