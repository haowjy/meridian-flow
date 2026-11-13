import { type DevMode, isTruthy } from "./dev-mode";
import type { DevSessionMetadata } from "./dev-session-state";
import { resolveStackEnv } from "./dev-stack-env";
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
  /** The line sent to tmux and recorded in session metadata. Holds no values from the environment. */
  line: string;
  /** The environment the stack's tmux session starts with: never in `line`, which tmux echoes and `ps` shows. */
  env: Record<string, string>;
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The keys this plan computes over the caller's environment. */
function computedStackEnv(
  env: NodeJS.ProcessEnv,
  internalApiOrigin: string,
  mode: DevMode,
  worktreePrefix: string | undefined,
): Record<string, string | undefined> {
  const proxyPort = resolvePortlessProxyPort(env);
  return {
    MERIDIAN_API_ORIGIN: internalApiOrigin,
    MERIDIAN_APP_ORIGIN: expectedServiceOrigin("app", worktreePrefix, proxyPort),
    // Local mode runs no www, so the app keeps sending signed-out people to sign-in.
    MERIDIAN_WWW_ORIGIN:
      mode === "local" ? undefined : expectedServiceOrigin("www", worktreePrefix, proxyPort),
    // Local dev opts into debug paths (./mf, debug routes, model capture) unless the caller or .env says otherwise.
    APP_DEBUG: env.APP_DEBUG ?? "1",
  };
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
  callerEnv = env,
  worktreePrefix,
  force = false,
}: {
  repoRoot: string;
  mode: DevMode;
  clientBuild?: DevSessionMetadata["clientBuild"];
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  /** The process environment, `.env` filled in: what the checks read. */
  env?: NodeJS.ProcessEnv;
  /** What the caller's shell set, before `.env` was filled in: what the stack inherits. */
  callerEnv?: NodeJS.ProcessEnv;
  worktreePrefix?: string;
  force?: boolean;
}): DevSessionCommand {
  const lan = isTruthy(env.PORTLESS_LAN);
  if ((mode === "funnel" || lan) && env.DEV_AUTH_BYPASS === "1") {
    throw new Error(
      "DEV_AUTH_BYPASS=1 signs every request in as the dev user; --funnel and PORTLESS_LAN publish the stack beyond this machine. Unset DEV_AUTH_BYPASS, drop --funnel, or unset PORTLESS_LAN.",
    );
  }
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
    return `pnpm exec tsx tools/dev/with-dev-env.ts -- pnpm exec portless --name ${shellQuote(name)}${force ? " --force" : ""}${appPortFlag} ${localStackEnv}pnpm --filter ${pkg} ${script}`;
  });

  // A tmux server started from another checkout can leave that checkout's
  // DATABASE_URL in the pane: unset it so the loader derives this one.
  const stack = `(unset DATABASE_URL PORTLESS_TAILSCALE PORTLESS_FUNNEL; ${commands.map((command) => `${command} & sleep 2`).join("; ")}; wait)`;
  return {
    // tmux ignores `new-session -c` once its server's cwd has been deleted, so the
    // command anchors itself; every path below is relative to the checkout.
    line: `cd ${shellQuote(repoRoot)} && mkdir -p logs logs/events && ${stack} 2>&1 | tee ${logPath}`,
    env: resolveStackEnv(callerEnv, computedStackEnv(env, internalApiOrigin, mode, worktreePrefix)),
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
  callerEnv,
  force = false,
}: {
  repoRoot: string;
  session: DevSessionPlan["session"];
  callerEnv: NodeJS.ProcessEnv;
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
      callerEnv,
      worktreePrefix: session.worktreePrefix,
      force,
    }),
  };
}
