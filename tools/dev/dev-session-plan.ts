import { resolveAppEnvPassthroughKeys } from "./dev-app-env-passthrough";
import type { DevMode } from "./dev-mode";
import type { DevSessionMetadata } from "./dev-session-state";
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
  /** The line sent to tmux and recorded in session metadata. Holds no secret values. */
  line: string;
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

function envAssignments(env: NodeJS.ProcessEnv, keys: readonly string[]): string[] {
  return keys
    .filter((key) => env[key] !== undefined)
    .map((key) => `${key}=${shellQuote(env[key] ?? "")}`);
}

function portlessEnvPrefix(env: NodeJS.ProcessEnv): string {
  const assignments = envAssignments(env, PORTLESS_ENV_KEYS);
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

/** Exports for the stack's subshell: only keys the caller set or this plan computes. */
function stackEnvExports(env: NodeJS.ProcessEnv, internalApiOrigin: string): string {
  const runtimeEnv = appRuntimeEnv(env, internalApiOrigin);
  return envAssignments(runtimeEnv, resolveAppEnvPassthroughKeys(runtimeEnv))
    .map((assignment) => `export ${assignment}; `)
    .join("");
}

function sharedPortsByService(
  sharedPorts: ReadonlyArray<SharedDevServicePorts>,
): Map<SharedDevServiceName, SharedDevServicePorts> {
  return new Map(sharedPorts.map((ports) => [ports.service, ports]));
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
    // with-dev-env fills every key from .env.local and the main .env, so no
    // secret travels in this command line.
    return `${portlessEnvPrefix(env)}pnpm exec tsx tools/dev/with-dev-env.ts -- pnpm exec portless --name ${shellQuote(name)}${force ? " --force" : ""}${appPortFlag} ${localStackEnv}pnpm --filter ${pkg} ${script}`;
  });

  // Everything below runs in the subshell, so nothing is exported into the pane's
  // interactive shell. A tmux server started from another checkout can leave that
  // checkout's DATABASE_URL in the pane: unset it so the loader derives this one.
  const stack = `(unset DATABASE_URL PORTLESS_TAILSCALE PORTLESS_FUNNEL; ${stackEnvExports(env, internalApiOrigin)}${commands.map((command) => `${command} & sleep 2`).join("; ")}; wait)`;
  return {
    // tmux ignores `new-session -c` once its server's cwd has been deleted, so the
    // command anchors itself; every path below is relative to the checkout.
    line: `cd ${shellQuote(repoRoot)} && mkdir -p logs logs/events && ${stack} 2>&1 | tee ${logPath}`,
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
