import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyModeEnv, parseDevCliOptions } from "./dev-mode";
import { printFailure, printSessionInfo } from "./dev-output";
import { waitForDevReadiness } from "./dev-readiness";
import { COMPUTED_STACK_KEYS, createDevSessionPlan, type DevSessionPlan } from "./dev-session-plan";
import { readDevSessionState, writeDevSessionMetadata } from "./dev-session-state";
import { applyDevEnvToProcess, resolveCheckoutSessionIdentity, runGit } from "./lib/dev-env";
import {
  clearIdleStopRecord,
  readIdleStopRecord,
  resolveIdleStopMinutes,
  WATCH_WINDOW,
} from "./lib/dev-idle.ts";
import { assertDevInfraReady } from "./lib/dev-infra";
import { collectStacks, formatStackTable, mb, memAvailableBytes } from "./lib/dev-stacks-report";
import { DEV_TMUX_SOCKET } from "./lib/dev-tmux-socket";
import { releaseFixedPorts } from "./lib/port-lifecycle";
import { prunePortlessRoutes } from "./lib/portless-maintenance";
import { pidBelongsToCheckout, processWorkingDirectory } from "./lib/route-ownership";
import { TailscaleDevLifecycle } from "./lib/tailscale-lifecycle";
import { collectOrphanDevSessions, stopOrphanDevSessions } from "./lib/worktree-cleanup-orphans";
import { resolveCheckoutPortlessPrefix } from "./portless-prefix";
import {
  type ExternalDevRoute,
  expectedServiceHost,
  formatDevRouteLines,
  getExpectedServicesForMode,
  parsePortlessListOutput,
  resolveExpectedRouteUrls,
  resolvePortlessProxyPort,
  validateExpectedRoutes,
} from "./portless-routes";
import { type CommandResult, TmuxSessionStore } from "./tmux-session-store";

const repoRoot = fs.realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
);
const logPath = "logs/portless.log";

function requireSuccess(result: CommandResult, fallback: string): void {
  if (result.status !== 0) throw new Error(result.stderr.trim() || fallback);
}

function readPortlessState(
  store: TmuxSessionStore,
  plan: DevSessionPlan,
  externalRoutes: ExternalDevRoute[] = [],
) {
  const result = store.run("pnpm", ["portless:list"]);
  const { mode, worktreePrefix } = plan.session;
  const proxyPort = resolvePortlessProxyPort();
  const validation = validateExpectedRoutes({
    output: result.stdout,
    mode,
    worktreePrefix,
    proxyPort,
    expectedPorts: plan.expectedPorts,
    ownsPid: (pid) => pidBelongsToCheckout(pid, repoRoot),
  });
  if (result.status !== 0)
    validation.errors.push(result.stderr.trim() || "pnpm portless:list failed");
  return {
    healthy: validation.errors.length === 0,
    errors: validation.errors,
    lines: formatDevRouteLines(result.stdout, mode, worktreePrefix, externalRoutes, proxyPort),
    origins: resolveExpectedRouteUrls({ output: result.stdout, mode, worktreePrefix, proxyPort }),
  };
}

function waitForPortlessState(store: TmuxSessionStore, plan: DevSessionPlan, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let state = readPortlessState(store, plan);
  while (!state.healthy && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    state = readPortlessState(store, plan);
  }
  return state;
}

function checkRouteConflicts(store: TmuxSessionStore, plan: DevSessionPlan, force: boolean): void {
  const result = store.run("pnpm", ["portless:list"]);
  requireSuccess(result, "cannot inspect Portless routes");
  const proxyPort = resolvePortlessProxyPort();
  const expected = new Set(
    getExpectedServicesForMode(plan.session.mode).map((service) =>
      expectedServiceHost(service.name, plan.session.worktreePrefix, proxyPort),
    ),
  );
  const conflicts = parsePortlessListOutput(result.stdout).routes.filter((route) =>
    expected.has(route.host),
  );
  for (const route of conflicts) {
    const cwd = route.pid ? processWorkingDirectory(route.pid) : undefined;
    console.warn(
      `${force ? "taking over" : "route conflict:"} ${route.host} from PID ${route.pid ?? "unknown"} (${cwd ?? "checkout unknown"}, backend ${route.port})`,
    );
  }
  if (conflicts.length && !force)
    throw new Error(
      "expected routes are already registered; use pnpm dev --restart or pnpm dev --force to take over",
    );
}

function warnIfMemoryLow(): void {
  const limitGb = Number(process.env.DEV_LOW_MEMORY_GB ?? 8);
  const available = memAvailableBytes();
  if (!(limitGb > 0) || available >= limitGb * 1024 ** 3) return;
  console.warn(
    `warning: ${mb(available)} of memory is available (limit ${limitGb} GB, DEV_LOW_MEMORY_GB). Running dev stacks:`,
  );
  console.warn(formatStackTable(collectStacks()));
  console.warn("Stop idle ones in their checkout with: pnpm dev --stop\n");
}

function teardownSessions(store: TmuxSessionStore, names: string[]): void {
  for (const name of new Set(names)) {
    if (store.sessionExists(name))
      requireSuccess(store.killSession(name), `failed to kill tmux session '${name}'`);
  }
  prunePortlessRoutes(repoRoot);
}

async function releaseBackendPorts(plan: DevSessionPlan): Promise<void> {
  const result = await releaseFixedPorts(
    plan.sharedPorts.map((entry) => entry.appBackendPort),
    {
      onKill: ({ port, holder }) =>
        console.log(`killing port ${port} holder PID ${holder.pid} (${holder.command})`),
    },
  );
  if (result.status === "discoveryError")
    throw new Error(
      result.errors
        .map(({ port, error }) => `port ${port} could not be inspected: ${error}`)
        .join("; "),
    );
  if (result.status === "stillHeld")
    throw new Error(
      result.held
        .map(
          ({ port, holders }) =>
            `port ${port} still held after SIGKILL by ${holders.map((holder) => `PID ${holder.pid} (${holder.command})`).join(", ")}`,
        )
        .join("; "),
    );
}

function printDryRun(plan: DevSessionPlan, launchCommand: string): void {
  console.log("[dry-run] dev session plan");
  console.log(`session: ${plan.session.sessionName}`);
  console.log(`mode: ${plan.session.mode}`);
  console.log(`client build: ${plan.session.clientBuild}`);
  console.log(`repo root: ${repoRoot}`);
  console.log(`branch: ${plan.session.branch}`);
  console.log(`metadata: ${path.join(repoRoot, ".meridian", "dev-session.json")}`);
  for (const entry of plan.sharedPorts)
    console.log(
      `shared port: ${entry.service}=backend:${entry.appBackendPort},${entry.externalMode}:${entry.externalHttpsPort}`,
    );
  console.log(
    `tmux -L ${DEV_TMUX_SOCKET} new-session -d -s ${plan.session.sessionName} -c ${repoRoot} (with -e for ${Object.keys(plan.command.env).length} variables: ${Object.keys(plan.command.env).join(", ")})`,
  );
  console.log(
    `tmux -L ${DEV_TMUX_SOCKET} send-keys -t ${plan.session.sessionName}:0 -- ${launchCommand} C-m`,
  );
}

async function verifyAndPublish({
  store,
  tailscale,
  plan,
  alreadyRunning,
  launchCommand,
}: {
  store: TmuxSessionStore;
  tailscale: TailscaleDevLifecycle;
  plan: DevSessionPlan;
  alreadyRunning: boolean;
  launchCommand: string;
}): Promise<void> {
  const fail = (message: string, lines: string[] = []): never => {
    printFailure({
      sessionName: plan.session.sessionName,
      message,
      remediation: "inspect logs/routes and restart with pnpm dev --restart",
      logPath,
      routeLines: lines,
    });
    throw new Error("dev session verification failed");
  };
  const timeoutMs = alreadyRunning
    ? 5_000
    : plan.session.clientBuild === "production"
      ? 60_000
      : 20_000;
  const routes = waitForPortlessState(store, plan, timeoutMs);
  if (!routes.healthy) fail(`route checks failed: ${routes.errors.join("; ")}`, routes.lines);
  const readiness = await waitForDevReadiness({ origins: routes.origins, timeoutMs });
  if (!readiness.ok) fail(`readiness checks failed: ${readiness.errors.join("; ")}`, routes.lines);

  writeDevSessionMetadata(repoRoot, {
    ...plan.session,
    command: launchCommand,
    externalRoutes: [],
  });
  let externalRoutes: ExternalDevRoute[];
  try {
    const nodeDnsName = plan.session.mode === "local" ? undefined : tailscale.resolveNodeDnsName();
    externalRoutes = tailscale.ensureExternalRoutes({ sharedPorts: plan.sharedPorts, nodeDnsName });
  } catch (error) {
    return fail(
      `Tailscale route verification failed: ${error instanceof Error ? error.message : String(error)}`,
      routes.lines,
    );
  }
  const verified = readPortlessState(store, plan, externalRoutes);
  if (!verified.healthy)
    fail(`route ownership changed during readiness: ${verified.errors.join("; ")}`, verified.lines);
  writeDevSessionMetadata(repoRoot, { ...plan.session, command: launchCommand, externalRoutes });
  printSessionInfo({
    headline: alreadyRunning ? "already running" : "started",
    sessionName: plan.session.sessionName,
    mode: plan.session.mode,
    clientBuild: plan.session.clientBuild,
    routeLines: verified.lines,
  });
}

function keepRunningStackEnv(store: TmuxSessionStore, sessionNames: string[]): void {
  const running = sessionNames.map((name) => store.sessionEnv(name)).find((env) => env !== null);
  if (!running) {
    console.log("note: no running stack to keep the environment of; starting with this shell's");
    return;
  }
  const recomputed = new Set<string>(COMPUTED_STACK_KEYS);
  const kept = Object.keys(running).filter(
    (key) => process.env[key] === undefined && !recomputed.has(key),
  );
  for (const key of kept) process.env[key] = running[key];
  if (kept.length > 0) console.log(`kept from the running stack: ${kept.sort().join(", ")}`);
}

async function main(): Promise<void> {
  const store = new TmuxSessionStore(repoRoot);
  const tailscale = new TailscaleDevLifecycle();
  const options = parseDevCliOptions({ argv: process.argv.slice(2) });
  const identity = resolveCheckoutSessionIdentity(repoRoot);
  const state = readDevSessionState(repoRoot);
  const previous = state.recorded;
  const active = options.restart ? null : state.active;
  const requestedClientBuild = options.productionClient ? "production" : "development";
  if (!options.stop && active && active.clientBuild !== requestedClientBuild) {
    const restartCommand = options.productionClient
      ? "pnpm dev:production-client --restart"
      : "pnpm dev --restart";
    throw new Error(
      `the active session uses the ${active.clientBuild} client; run ${restartCommand} to use the ${requestedClientBuild} client`,
    );
  }
  const sessionNames = [identity.sessionName, ...(previous ? [previous.sessionName] : [])];
  if (options.restart && !options.stop) keepRunningStackEnv(store, sessionNames);
  const mode =
    active?.mode ??
    (options.restart && options.preserveModeOnRestart && !options.explicitModeFlag && previous
      ? previous.mode
      : options.mode);
  applyModeEnv(mode);
  const callerEnv = { ...process.env };
  if (!options.stop && !active) applyDevEnvToProcess(repoRoot);
  const session = active ?? {
    sessionName: identity.sessionName,
    branch: runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    mode,
    clientBuild:
      options.restart && options.preserveModeOnRestart && !options.productionClient && previous
        ? previous.clientBuild
        : requestedClientBuild,
    worktreePrefix: resolveCheckoutPortlessPrefix(repoRoot),
    createdAt: new Date().toISOString(),
  };
  const plan = createDevSessionPlan({
    repoRoot,
    session,
    callerEnv,
    force: options.restart,
  });
  if (options.print) return printDryRun(plan, active?.command ?? plan.command.line);
  if (!store.hasCommandOnPath("tmux"))
    throw new Error("tmux is required but was not found on PATH. Install tmux and retry.");
  for (const name of sessionNames) {
    if (store.legacyDefaultServerHasSession(name))
      throw new Error(
        `a dev stack from an older pnpm dev is still on your default tmux server as '${name}'. ` +
          `Stop it with: tmux -L default kill-session -t =${name}  (or pnpm dev --stop from the previous build), then retry.`,
      );
  }
  if (options.stop) {
    tailscale.cleanupExternalRoutes({
      previousRoutes: previous?.externalRoutes,
      sharedPorts: plan.sharedPorts,
    });
    teardownSessions(store, sessionNames);
    console.log(`stopped: ${session.sessionName}`);
    return;
  }
  await stopOrphanDevSessions(repoRoot, collectOrphanDevSessions(repoRoot));
  prunePortlessRoutes(repoRoot);

  if (!active) {
    await assertDevInfraReady();
    checkRouteConflicts(store, plan, options.restart);
    if (options.restart) {
      tailscale.cleanupExternalRoutes({
        previousRoutes: previous?.externalRoutes,
        sharedPorts: plan.sharedPorts,
      });
      teardownSessions(store, sessionNames);
      await releaseBackendPorts(plan);
    }
    await tailscale.pruneStaleRoutes();
    warnIfMemoryLow();
    const stopRecord = readIdleStopRecord(repoRoot);
    if (stopRecord) {
      console.log(`note: ${stopRecord}`);
      clearIdleStopRecord(repoRoot);
    }
    requireSuccess(
      store.createSession(session.sessionName, plan.command.env),
      `failed to create tmux session '${session.sessionName}'`,
    );
    writeDevSessionMetadata(repoRoot, {
      ...session,
      command: plan.command.line,
      externalRoutes: [],
    });
    requireSuccess(
      store.sendKeys(session.sessionName, plan.command.line),
      "failed to start portless in tmux",
    );
    const idleMinutes = resolveIdleStopMinutes();
    if (idleMinutes > 0) {
      requireSuccess(
        store.startWindow(
          session.sessionName,
          WATCH_WINDOW,
          `exec bun tools/dev/dev-idle-watch.ts ${session.sessionName} ${idleMinutes}`,
        ),
        "failed to start the idle watcher",
      );
    }
  }
  await verifyAndPublish({
    store,
    tailscale,
    plan,
    alreadyRunning: active !== null,
    launchCommand: active?.command ?? plan.command.line,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
