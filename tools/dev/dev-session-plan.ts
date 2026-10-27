import { resolveAppEnvPassthroughKeys } from "./dev-app-env-passthrough";
import type { DevMode } from "./dev-mode";
import type { DevSessionMetadata } from "./dev-session-state";
import { resolveDevRuntimeEnvPassthroughKeys } from "./lib/dev-env";
import {
  resolveSharedDevServicePorts,
  type SharedDevServiceName,
  type SharedDevServicePorts,
} from "./lib/dev-share-ports";
import {
  type ExpectedServiceName,
  expectedPortlessName,
  expectedServiceOrigin,
  resolvePortlessProxyPort,
} from "./portless-routes";

const logPath = "logs/portless.log";

export interface DevSessionPlan {
  readonly session: Omit<DevSessionMetadata, "command" | "externalRoutes">;
  readonly command: DevSessionCommand;
  readonly sharedPorts: readonly SharedDevServicePorts[];
  readonly expectedPorts: Partial<Record<ExpectedServiceName, number>>;
}

interface DevServiceSpec {
  serviceName: ExpectedServiceName;
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
  { serviceName: "app", pkg: "@meridian/app", shared: true },
  {
    serviceName: "server",
    pkg: "@meridian/server",
    shared: false,
  },
  {
    serviceName: "www",
    pkg: "@meridian/www",
    shared: true,
    sharedModeOnly: true,
  },
];

const PORTLESS_ENV_KEYS = [
  "PORTLESS_LAN",
  "PORTLESS_HTTPS",
  "PORTLESS_PORT",
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
    // Local dev opts into debug paths (./mf, debug routes, model capture) unless .env says otherwise.
    APP_DEBUG: env.APP_DEBUG ?? "1",
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
  clientBuild,
  sharedPorts,
  env,
  redacted,
  worktreePrefix,
  force,
}: {
  mode: DevMode;
  clientBuild: DevSessionMetadata["clientBuild"];
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  env: NodeJS.ProcessEnv;
  redacted: boolean;
  worktreePrefix?: string;
  force: boolean;
}): string {
  const portsByService = sharedPortsByService(sharedPorts);
  const commands = DEV_SERVICES.filter(
    (service) => mode !== "local" || !service.sharedModeOnly,
  ).map(({ serviceName, pkg }) => {
    const servicePorts =
      serviceName === "app" || serviceName === "www" ? portsByService.get(serviceName) : undefined;
    const appPortFlag = servicePorts ? ` --app-port ${servicePorts.appBackendPort}` : "";
    const name = expectedPortlessName(serviceName, worktreePrefix);
    const productionApp = serviceName === "app" && clientBuild === "production";
    const script = productionApp ? "profile:dev-stack" : "dev";
    const localStackEnv = productionApp ? "env APP_ENV=dev MERIDIAN_LOCAL_DEV_STACK=1 " : "";
    return `${portlessEnvPrefix(env, redacted)}pnpm exec portless --name ${shellQuote(name)}${force ? " --force" : ""}${appPortFlag} ${localStackEnv}pnpm --filter ${pkg} ${script}`;
  });

  return `(${commands.map((command) => `${command} & sleep 2`).join("; ")}; wait)`;
}

function renderPortlessCommand({
  repoRoot,
  mode,
  clientBuild,
  sharedPorts,
  env,
  internalApiOrigin,
  redacted,
  worktreePrefix,
  force,
}: {
  repoRoot: string;
  mode: DevMode;
  clientBuild: DevSessionMetadata["clientBuild"];
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  env: NodeJS.ProcessEnv;
  internalApiOrigin: string;
  redacted: boolean;
  worktreePrefix?: string;
  force: boolean;
}): string {
  // tmux ignores `new-session -c` once its server's cwd has been deleted, so the
  // command anchors itself; every path below is relative to the checkout.
  return `cd ${shellQuote(repoRoot)} && mkdir -p logs logs/events && ${envSourcePreamble(
    env,
    internalApiOrigin,
    redacted,
  )} && unset PORTLESS_TAILSCALE PORTLESS_FUNNEL && ${portlessCommandBody({
    mode,
    clientBuild,
    sharedPorts,
    env,
    redacted,
    worktreePrefix,
    force,
  })} 2>&1 | tee ${logPath}`;
}

export function resolveInternalApiOrigin(
  worktreePrefix?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return expectedServiceOrigin("server", worktreePrefix, resolvePortlessProxyPort(env));
}

export function createDevSessionCommand({
  repoRoot,
  mode,
  clientBuild = "development",
  sharedPorts,
  env = process.env,
  worktreePrefix,
  force = false,
}: {
  repoRoot: string;
  mode: DevMode;
  clientBuild?: DevSessionMetadata["clientBuild"];
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  env?: NodeJS.ProcessEnv;
  worktreePrefix?: string;
  force?: boolean;
}): DevSessionCommand {
  const internalApiOrigin = resolveInternalApiOrigin(worktreePrefix, env);
  return {
    executable: renderPortlessCommand({
      repoRoot,
      mode,
      clientBuild,
      sharedPorts,
      env,
      internalApiOrigin,
      redacted: false,
      worktreePrefix,
      force,
    }),
    display: renderPortlessCommand({
      repoRoot,
      mode,
      clientBuild,
      sharedPorts,
      env,
      internalApiOrigin,
      redacted: true,
      worktreePrefix,
      force,
    }),
    internalApiOrigin,
  };
}

export function sharedServiceNamesForMode(mode: DevMode): SharedDevServiceName[] {
  if (mode === "local") return [];

  return DEV_SERVICES.filter(
    (service): service is DevServiceSpec & { serviceName: SharedDevServiceName } =>
      service.shared && (service.serviceName === "app" || service.serviceName === "www"),
  ).map((service) => service.serviceName);
}

export function createDevSessionPlan({
  repoRoot,
  session,
  force = false,
}: {
  repoRoot: string;
  session: DevSessionPlan["session"];
  force?: boolean;
}): DevSessionPlan {
  const sharedPorts = resolveSharedDevServicePorts({
    mode: session.mode,
    worktreeKey: repoRoot,
    services: sharedServiceNamesForMode(session.mode),
  });
  return {
    session,
    sharedPorts,
    expectedPorts: Object.fromEntries(
      sharedPorts.map((entry) => [entry.service, entry.appBackendPort]),
    ),
    command: createDevSessionCommand({
      repoRoot,
      mode: session.mode,
      clientBuild: session.clientBuild,
      sharedPorts,
      worktreePrefix: session.worktreePrefix,
      force,
    }),
  };
}
