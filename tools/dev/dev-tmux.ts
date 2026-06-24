import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAppEnvPassthroughKeys } from "./dev-app-env-passthrough";
import { applyModeEnv, type DevMode, parseDevCliOptions } from "./dev-mode";
import { printFailure, printSessionInfo } from "./dev-output";
import { runGit } from "./lib/dev-env";
import { assertDevInfraReady } from "./lib/dev-infra";
import {
  resolveSharedDevServicePorts,
  type SharedDevServiceName,
  type SharedDevServicePorts,
} from "./lib/dev-share-ports";
import {
  findStaleTailscaleRoutes,
  parseTailscaleServeStatusJson,
  type TailscaleRouteBinding,
  tailscaleRouteOffArgs,
} from "./lib/tailscale-stale-routes";
import { branchToPortlessPrefix } from "./portless-prefix";
import {
  type ExpectedServiceName,
  type ExternalDevRoute,
  formatDevRouteLines,
  getExpectedServicesForMode,
  validateExpectedRoutes,
} from "./portless-routes";
import { resolveSessionIdentity } from "./session-identity";
import { TmuxSessionStore } from "./tmux-session-store";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRootRealpath = fs.realpathSync(repoRoot);
const metadataPath = path.join(repoRoot, ".meridian", "dev-session.json");
const logPath = "logs/portless.log";

/**
 * Slim record of the running dev session, written to `.meridian/dev-session.json`
 * after a fresh launch. Read only to report the current mode on reuse and to let
 * `pnpm dev:restart` (`--preserve-mode`) recreate the mode that was running.
 */
interface DevSessionMetadata {
  sessionName: string;
  mode: DevMode;
  branch: string;
  command: string;
  createdAt: string;
  externalRoutes?: ExternalDevRoute[];
}

interface PortlessState {
  lines: string[];
  servicePids: Record<string, number>;
  healthy: boolean;
  errors: string[];
}

function isLinkedWorktree(): boolean {
  const gitDir = runGit(repoRoot, ["rev-parse", "--git-dir"]);
  const commonDir = runGit(repoRoot, ["rev-parse", "--git-common-dir"]);
  if (!gitDir || !commonDir) return false;

  const resolvedGitDir = path.resolve(repoRoot, gitDir);
  const resolvedCommonDir = path.resolve(repoRoot, commonDir);
  return resolvedGitDir !== resolvedCommonDir;
}

function detectWorktreePrefix(branchName: string): string | undefined {
  if (!isLinkedWorktree()) return undefined;
  return branchToPortlessPrefix(branchName);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function isDevMode(value: string | null | undefined): value is DevMode {
  return value === "local" || value === "tailscale" || value === "funnel";
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function commandErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.toString().trim()) return stderr.toString().trim();
  }

  return error instanceof Error ? error.message : String(error);
}

function readTailscaleStatusJson(args: string[]): unknown | null {
  try {
    const output = execFileSync("tailscale", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output) as unknown;
  } catch {
    return null;
  }
}

function readTailscaleRouteBindings(): TailscaleRouteBinding[] {
  const seen = new Set<string>();
  const bindings: TailscaleRouteBinding[] = [];

  for (const { args, modeOverride } of [
    { args: ["serve", "status", "--json"], modeOverride: undefined },
    { args: ["funnel", "status", "--json"], modeOverride: "funnel" as const },
  ]) {
    const status = readTailscaleStatusJson(args);
    if (!status) continue;

    for (const parsedBinding of parseTailscaleServeStatusJson(status)) {
      const binding = modeOverride ? { ...parsedBinding, mode: modeOverride } : parsedBinding;
      const key = `${binding.mode}:${binding.httpsPort}:${binding.localPort}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bindings.push(binding);
    }
  }

  return bindings;
}

function isLocalPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (live: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(live);
    };

    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function pruneStaleTailscaleRoutes(): Promise<void> {
  const bindings = readTailscaleRouteBindings();
  if (bindings.length === 0) return;

  const liveness = new Map<number, boolean>();
  for (const localPort of [...new Set(bindings.map((binding) => binding.localPort))]) {
    liveness.set(localPort, await isLocalPortListening(localPort));
  }

  const staleRoutes = findStaleTailscaleRoutes(bindings, (port) => liveness.get(port) ?? false);
  let pruned = 0;

  for (const route of staleRoutes) {
    try {
      execFileSync("tailscale", tailscaleRouteOffArgs(route), {
        stdio: ["ignore", "pipe", "pipe"],
      });
      pruned += 1;
    } catch (error) {
      const message = commandErrorText(error);
      if (!/handler does not exist/i.test(message)) {
        console.warn(`tailscale ${route.mode} --https=${route.httpsPort} off warning: ${message}`);
      }
    }
  }

  if (pruned > 0) {
    console.log(`pruned ${pruned} stale tailscale route${pruned === 1 ? "" : "s"}`);
  }
}

function portlessEnvPrefix(_shared: boolean): string {
  const commonKeys = [
    "PORTLESS_LAN",
    "PORTLESS_HTTPS",
    "PORTLESS_TLD",
    "PORTLESS_WILDCARD",
    "PORTLESS_SYNC_HOSTS",
    "PORTLESS_STATE_DIR",
  ];

  const passThroughKeys = commonKeys;
  const assignments = passThroughKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => `${key}=${shellQuote(process.env[key] ?? "")}`);

  return assignments.length > 0 ? `env ${assignments.join(" ")} ` : "";
}

function appEnvPassthroughExports(): string {
  const exports = resolveAppEnvPassthroughKeys(process.env).map(
    (key) => `export ${key}=${shellQuote(process.env[key] ?? "")}`,
  );

  return exports.length > 0 ? `; ${exports.join("; ")}` : "";
}

function envSourcePreamble(): string {
  return `set -a; [ -f .env ] && . ./.env; set +a${appEnvPassthroughExports()}`;
}

// Keep names in sync with SERVICE_HOST_SUFFIXES in portless-routes.ts; portless adds `.localhost`.
const DEV_SERVICES: ReadonlyArray<{
  serviceName: ExpectedServiceName;
  portlessName: string;
  pkg: string;
  shared: boolean;
  sharedModeOnly?: boolean;
}> = [
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

function sharedServiceNamesForMode(mode: DevMode): SharedDevServiceName[] {
  if (mode === "local") return [];

  return DEV_SERVICES.filter(
    (service): service is (typeof DEV_SERVICES)[number] & { serviceName: SharedDevServiceName } =>
      service.shared && (service.serviceName === "app" || service.serviceName === "www"),
  )
    .filter((service) => mode !== "local" || !service.sharedModeOnly)
    .map((service) => service.serviceName);
}

function sharedPortsByService(
  sharedPorts: ReadonlyArray<SharedDevServicePorts>,
): Map<SharedDevServiceName, SharedDevServicePorts> {
  return new Map(sharedPorts.map((ports) => [ports.service, ports]));
}

function externalRoutesFromSharedPorts(
  sharedPorts: ReadonlyArray<SharedDevServicePorts>,
  nodeDnsName?: string,
): ExternalDevRoute[] {
  const host = nodeDnsName?.replace(/\.$/, "");

  return sharedPorts.map((ports) => ({
    service: ports.service,
    mode: ports.externalMode,
    httpsPort: ports.externalHttpsPort,
    url: host ? `https://${host}:${ports.externalHttpsPort}` : undefined,
  }));
}

function portlessCommandBody(
  mode: DevMode,
  sharedPorts: ReadonlyArray<SharedDevServicePorts>,
): string {
  const portsByService = sharedPortsByService(sharedPorts);
  const commands = DEV_SERVICES.filter(
    (service) => mode !== "local" || !service.sharedModeOnly,
  ).map(({ serviceName, portlessName, pkg, shared }) => {
    const servicePorts =
      serviceName === "app" || serviceName === "www" ? portsByService.get(serviceName) : undefined;
    const appPortFlag = servicePorts ? ` --app-port ${servicePorts.appBackendPort}` : "";
    return `${portlessEnvPrefix(shared)}pnpm exec portless run --name ${portlessName}${appPortFlag} pnpm --filter ${pkg} dev`;
  });

  return `(${commands.map((command) => `${command} & sleep 2`).join("; ")}; wait)`;
}

function createPortlessCommand(
  mode: DevMode,
  sharedPorts: ReadonlyArray<SharedDevServicePorts>,
): string {
  return `mkdir -p logs && ${envSourcePreamble()} && ${portlessCommandBody(mode, sharedPorts)} 2>&1 | tee ${logPath}`;
}

function readPortlessState(
  tmuxStore: TmuxSessionStore,
  mode: DevMode,
  worktreePrefix?: string,
  externalRoutes: ReadonlyArray<ExternalDevRoute> = [],
): PortlessState {
  const result = tmuxStore.run("pnpm", ["portless:list"]);
  if (result.status !== 0) {
    return {
      lines: [],
      servicePids: {},
      healthy: false,
      errors: [result.stderr.trim() || "pnpm portless:list failed"],
    };
  }

  const validation = validateExpectedRoutes({ output: result.stdout, mode, worktreePrefix });
  return {
    lines: formatDevRouteLines(result.stdout, mode, worktreePrefix, externalRoutes),
    servicePids: validation.servicePids,
    healthy: validation.ok,
    errors: validation.errors,
  };
}

function waitForPortlessState(
  tmuxStore: TmuxSessionStore,
  mode: DevMode,
  timeoutMs: number,
  worktreePrefix?: string,
  externalRoutes: ReadonlyArray<ExternalDevRoute> = [],
): PortlessState {
  const deadline = Date.now() + timeoutMs;
  let state = readPortlessState(tmuxStore, mode, worktreePrefix, externalRoutes);

  while (!state.healthy && Date.now() < deadline) {
    sleep(500);
    state = readPortlessState(tmuxStore, mode, worktreePrefix, externalRoutes);
  }

  return state;
}

function readJsonMetadata(): DevSessionMetadata | null {
  try {
    const data = fs.readFileSync(metadataPath, "utf8");
    return JSON.parse(data) as DevSessionMetadata;
  } catch {
    return null;
  }
}

function writeJsonMetadata(metadata: DevSessionMetadata): void {
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

function buildMetadata({
  branch,
  sessionName,
  mode,
  command,
  externalRoutes = [],
}: {
  branch: string;
  sessionName: string;
  mode: DevMode;
  command: string;
  externalRoutes?: ExternalDevRoute[];
}): DevSessionMetadata {
  return {
    sessionName,
    mode,
    branch: branch || "detached",
    command,
    createdAt: new Date().toISOString(),
    externalRoutes,
  };
}

function resolveRequestedMode({
  explicitMode,
  requestedMode,
  restart,
  preserveModeOnRestart,
}: {
  explicitMode: boolean;
  requestedMode: DevMode;
  restart: boolean;
  preserveModeOnRestart: boolean;
}): DevMode {
  if (!restart || !preserveModeOnRestart || explicitMode) {
    return requestedMode;
  }

  const previous = readJsonMetadata();
  return isDevMode(previous?.mode) ? previous.mode : requestedMode;
}

function printDryRun({
  sessionName,
  mode,
  branch,
  worktreeHash,
  portlessCommand,
  sharedPorts,
}: {
  sessionName: string;
  mode: DevMode;
  branch: string;
  worktreeHash: string;
  portlessCommand: string;
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
}): void {
  console.log("[dry-run] dev session plan");
  console.log(`session: ${sessionName}`);
  console.log(`mode: ${mode}`);
  console.log(`repo root: ${repoRootRealpath}`);
  console.log(`branch: ${branch || "HEAD"}`);
  console.log(`worktree hash: ${worktreeHash}`);
  console.log(`metadata: ${metadataPath}`);
  console.log(
    `expected services: ${getExpectedServicesForMode(mode)
      .map((service) => service.name)
      .join(", ")}`,
  );
  if (sharedPorts.length > 0) {
    console.log(
      `shared ports: ${sharedPorts
        .map(
          (ports) =>
            `${ports.service}=backend:${ports.appBackendPort},${ports.externalMode}:${ports.externalHttpsPort}`,
        )
        .join(", ")}`,
    );
  }

  console.log("[dry-run] tmux commands:");
  console.log(`tmux has-session -t ${sessionName}`);
  console.log(`tmux new-session -d -s ${sessionName} -c ${repoRoot}`);
  console.log(`tmux send-keys -t ${sessionName}:0 '${portlessCommand}' C-m`);
}

function failAndExit(
  message: string,
  remediation: string,
  sessionName: string,
  routeLines: string[] = [],
): never {
  printFailure({
    sessionName,
    message,
    remediation,
    logPath,
    routeLines,
  });
  process.exit(1);
}

function killSessionIfPresent(tmuxStore: TmuxSessionStore, sessionName: string): void {
  if (tmuxStore.sessionExists(sessionName)) {
    const killResult = tmuxStore.killSession(sessionName);
    if (killResult.status !== 0) {
      console.error(killResult.stderr.trim() || `failed to kill tmux session '${sessionName}'`);
      process.exit(killResult.status ?? 1);
    }
  }
}

function cleanupTailscaleRoutes(routes: ReadonlyArray<ExternalDevRoute>): void {
  for (const route of routes) {
    try {
      execFileSync("tailscale", [route.mode, `--https=${route.httpsPort}`, "off"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = commandErrorText(error);
      if (!/handler does not exist/i.test(message)) {
        console.warn(`tailscale ${route.mode} --https=${route.httpsPort} off warning: ${message}`);
      }
    }
  }
}

function tailscaleStatusDnsName(): string | undefined {
  const status = readTailscaleStatusJson(["status", "--json"]);
  if (typeof status !== "object" || status === null || !("Self" in status)) return undefined;

  const self = (status as { Self?: { DNSName?: unknown } }).Self;
  return typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "") : undefined;
}

function registerTailscaleRoutes(sharedPorts: ReadonlyArray<SharedDevServicePorts>): void {
  for (const ports of sharedPorts) {
    const command = ports.externalMode === "funnel" ? "funnel" : "serve";
    const args = [
      command,
      "--bg",
      "--yes",
      `--https=${ports.externalHttpsPort}`,
      `http://127.0.0.1:${ports.appBackendPort}`,
    ];

    try {
      execFileSync("tailscale", args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      throw new Error(
        `tailscale ${command} --https=${ports.externalHttpsPort} failed: ${commandErrorText(error)}`,
      );
    }
  }
}

function teardownExistingSessions(tmuxStore: TmuxSessionStore, sessionNames: string[]): void {
  for (const sessionName of [...new Set(sessionNames.filter(Boolean))]) {
    killSessionIfPresent(tmuxStore, sessionName);
  }

  const pruneResult = tmuxStore.run("pnpm", ["exec", "portless", "prune"]);
  if (pruneResult.status !== 0) {
    const stderr = pruneResult.stderr.trim();
    if (stderr) {
      console.warn(`portless prune warning: ${stderr}`);
    }
  }
}

async function main(): Promise<void> {
  const tmuxStore = new TmuxSessionStore(repoRoot);
  const cliOptions = parseDevCliOptions({ argv: process.argv.slice(2) });

  const branchName = runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const detachedHeadRef = runGit(repoRoot, ["rev-parse", "--short", "HEAD"]);
  const identity = resolveSessionIdentity({
    branchName,
    detachedHeadRef,
    repoRootRealpath,
  });

  const mode = resolveRequestedMode({
    explicitMode: cliOptions.explicitModeFlag,
    requestedMode: cliOptions.mode,
    restart: cliOptions.restart,
    preserveModeOnRestart: cliOptions.preserveModeOnRestart,
  });

  applyModeEnv(mode);

  const previous = readJsonMetadata();
  const worktreePrefix = detectWorktreePrefix(branchName);
  const previousWorktreePrefix = previous ? detectWorktreePrefix(previous.branch) : undefined;
  const sharedPorts = resolveSharedDevServicePorts({
    mode,
    worktreeKey: repoRootRealpath,
    services: sharedServiceNamesForMode(mode),
  });
  const nodeDnsName = mode === "local" ? undefined : tailscaleStatusDnsName();
  const externalRoutes = externalRoutesFromSharedPorts(sharedPorts, nodeDnsName);
  const portlessCommand = createPortlessCommand(mode, sharedPorts);

  if (cliOptions.print) {
    printDryRun({
      sessionName: identity.sessionName,
      mode,
      branch: branchName,
      worktreeHash: identity.worktreeHash,
      portlessCommand,
      sharedPorts,
    });
    process.exit(0);
  }

  if (!tmuxStore.hasCommandOnPath("tmux")) {
    console.error("tmux is required but was not found on PATH. Install tmux and retry.");
    process.exit(1);
  }

  if (cliOptions.stop) {
    cleanupTailscaleRoutes(previous?.externalRoutes ?? externalRoutes);
    teardownExistingSessions(tmuxStore, [identity.sessionName, previous?.sessionName ?? ""]);
    console.log(`stopped · ${identity.sessionName}`);
    return;
  }

  // Fail fast if the dev database is unset or unreachable: the app servers boot
  // fine without Postgres (connections are lazy), so a stopped container would
  // otherwise only surface as a runtime HTTPError on the first DB-touching
  // request, long after this script reports the session healthy.
  await assertDevInfraReady();

  if (cliOptions.restart) {
    cleanupTailscaleRoutes(previous?.externalRoutes ?? externalRoutes);
    teardownExistingSessions(tmuxStore, [identity.sessionName, previous?.sessionName ?? ""]);
  } else if (tmuxStore.sessionExists(identity.sessionName)) {
    const runningMode = isDevMode(previous?.mode) ? previous.mode : mode;
    const routeState = waitForPortlessState(
      tmuxStore,
      runningMode,
      5_000,
      worktreePrefix,
      previous?.externalRoutes ?? externalRoutes,
    );
    printSessionInfo({
      headline: "already running",
      sessionName: identity.sessionName,
      mode: runningMode,
      routeLines: routeState.lines,
    });
    return;
  } else if (previous?.sessionName && tmuxStore.sessionExists(previous.sessionName)) {
    const runningMode = isDevMode(previous.mode) ? previous.mode : mode;
    const routeState = waitForPortlessState(
      tmuxStore,
      runningMode,
      5_000,
      previousWorktreePrefix,
      previous?.externalRoutes ?? externalRoutes,
    );
    printSessionInfo({
      headline: "already running",
      sessionName: previous.sessionName,
      mode: runningMode,
      routeLines: routeState.lines,
    });
    return;
  }

  await pruneStaleTailscaleRoutes();

  const createResult = tmuxStore.createSession(identity.sessionName);
  if (createResult.status !== 0) {
    console.error(
      createResult.stderr.trim() || `failed to create tmux session '${identity.sessionName}'`,
    );
    process.exit(createResult.status ?? 1);
  }

  const runResult = tmuxStore.sendKeys(identity.sessionName, portlessCommand);
  if (runResult.status !== 0) {
    console.error(runResult.stderr.trim() || "failed to start portless in tmux");
    process.exit(runResult.status ?? 1);
  }

  const routeState = waitForPortlessState(tmuxStore, mode, 20_000, worktreePrefix, externalRoutes);
  if (!routeState.healthy) {
    failAndExit(
      `dev session started but health checks failed: ${routeState.errors.join("; ")}`,
      "inspect logs/routes and restart with pnpm dev --restart",
      identity.sessionName,
      routeState.lines,
    );
  }

  registerTailscaleRoutes(sharedPorts);

  writeJsonMetadata(
    buildMetadata({
      branch: branchName,
      sessionName: identity.sessionName,
      mode,
      command: portlessCommand,
      externalRoutes,
    }),
  );

  printSessionInfo({
    headline: "started",
    sessionName: identity.sessionName,
    mode,
    routeLines: routeState.lines,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
