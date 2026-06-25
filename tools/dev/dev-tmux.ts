import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyModeEnv, type DevMode, parseDevCliOptions } from "./dev-mode";
import { printFailure, printSessionInfo } from "./dev-output";
import { waitForDevReadiness } from "./dev-readiness";
import {
  buildMetadata,
  createDevSessionCommand,
  type DevSessionMetadata,
  sharedServiceNamesForMode,
} from "./dev-session-plan";
import { applyDevEnvToProcess, runGit } from "./lib/dev-env";
import { assertDevInfraReady } from "./lib/dev-infra";
import { resolveSharedDevServicePorts, type SharedDevServicePorts } from "./lib/dev-share-ports";
import { TailscaleDevLifecycle } from "./lib/tailscale-lifecycle";
import { branchToPortlessPrefix } from "./portless-prefix";
import {
  type ExpectedServiceName,
  type ExternalDevRoute,
  formatDevRouteLines,
  getExpectedServicesForMode,
  resolveExpectedRouteUrls,
  validateExpectedRoutes,
} from "./portless-routes";
import { resolveSessionIdentity } from "./session-identity";
import { TmuxSessionStore } from "./tmux-session-store";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const repoRootRealpath = fs.realpathSync(repoRoot);
const metadataPath = path.join(repoRoot, ".meridian", "dev-session.json");
const logPath = "logs/portless.log";

interface PortlessState {
  lines: string[];
  servicePids: Record<string, number>;
  serviceOrigins: Partial<Record<ExpectedServiceName, string>>;
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

function isDevMode(value: string | null | undefined): value is DevMode {
  return value === "local" || value === "tailscale" || value === "funnel";
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
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
      serviceOrigins: {},
      healthy: false,
      errors: [result.stderr.trim() || "pnpm portless:list failed"],
    };
  }

  const validation = validateExpectedRoutes({ output: result.stdout, mode, worktreePrefix });
  return {
    lines: formatDevRouteLines(result.stdout, mode, worktreePrefix, externalRoutes),
    servicePids: validation.servicePids,
    serviceOrigins: resolveExpectedRouteUrls({ output: result.stdout, mode, worktreePrefix }),
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

function writeMetadataWithoutExternalRoutes({
  branch,
  sessionName,
  mode,
  displayCommand,
  createdAt,
}: {
  branch: string;
  sessionName: string;
  mode: DevMode;
  displayCommand: string;
  createdAt?: string;
}): void {
  writeJsonMetadata({
    branch: branch || "detached",
    sessionName,
    mode,
    command: displayCommand,
    createdAt: createdAt ?? new Date().toISOString(),
    externalRoutes: [],
  });
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
  console.log(`tmux send-keys -t ${sessionName}:0 -- ${portlessCommand} C-m`);
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

async function printExistingSessionInfo({
  tmuxStore,
  sessionName,
  mode,
  worktreePrefix,
  tailscale,
  sharedPorts,
  nodeDnsName,
  branch,
  displayCommand,
  createdAt,
}: {
  tmuxStore: TmuxSessionStore;
  sessionName: string;
  mode: DevMode;
  worktreePrefix?: string;
  tailscale: TailscaleDevLifecycle;
  sharedPorts: ReadonlyArray<SharedDevServicePorts>;
  nodeDnsName?: string;
  branch: string;
  displayCommand: string;
  createdAt?: string;
}): Promise<void> {
  const routeState = waitForPortlessState(tmuxStore, mode, 5_000, worktreePrefix);
  if (!routeState.healthy) {
    failAndExit(
      `dev session exists but route checks failed: ${routeState.errors.join("; ")}`,
      "inspect logs/routes and restart with pnpm dev --restart",
      sessionName,
      routeState.lines,
    );
  }

  const readiness = await waitForDevReadiness({
    origins: routeState.serviceOrigins,
    timeoutMs: 5_000,
  });
  if (!readiness.ok) {
    failAndExit(
      `dev session exists but readiness checks failed: ${readiness.errors.join("; ")}`,
      "inspect logs/routes and restart with pnpm dev --restart",
      sessionName,
      routeState.lines,
    );
  }

  let externalRoutes: ExternalDevRoute[];
  try {
    externalRoutes = tailscale.ensureExternalRoutes({ sharedPorts, nodeDnsName });
  } catch (error) {
    writeMetadataWithoutExternalRoutes({
      branch,
      sessionName,
      mode,
      displayCommand,
      createdAt,
    });
    failAndExit(
      `dev session exists but Tailscale route verification failed: ${error instanceof Error ? error.message : String(error)}`,
      "inspect tailscale serve/funnel status and restart with pnpm dev --restart",
      sessionName,
      routeState.lines,
    );
  }

  const verifiedRouteState = readPortlessState(tmuxStore, mode, worktreePrefix, externalRoutes);

  writeJsonMetadata({
    branch: branch || "detached",
    sessionName,
    mode,
    command: displayCommand,
    createdAt: createdAt ?? new Date().toISOString(),
    externalRoutes,
  });

  printSessionInfo({
    headline: "already running",
    sessionName,
    mode,
    routeLines: verifiedRouteState.lines,
  });
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
  const tailscale = new TailscaleDevLifecycle();
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

  if (cliOptions.print) {
    applyDevEnvToProcess(repoRoot);
    const devCommand = createDevSessionCommand({
      mode,
      sharedPorts,
      worktreePrefix,
    });
    printDryRun({
      sessionName: identity.sessionName,
      mode,
      branch: branchName,
      worktreeHash: identity.worktreeHash,
      portlessCommand: devCommand.display,
      sharedPorts,
    });
    process.exit(0);
  }

  if (!tmuxStore.hasCommandOnPath("tmux")) {
    console.error("tmux is required but was not found on PATH. Install tmux and retry.");
    process.exit(1);
  }

  if (cliOptions.stop) {
    tailscale.cleanupExternalRoutes({ previousRoutes: previous?.externalRoutes, sharedPorts });
    teardownExistingSessions(tmuxStore, [identity.sessionName, previous?.sessionName ?? ""]);
    console.log(`stopped · ${identity.sessionName}`);
    return;
  }

  applyDevEnvToProcess(repoRoot);
  const devCommand = createDevSessionCommand({
    mode,
    sharedPorts,
    worktreePrefix,
  });

  // Fail fast if the dev database is unset or unreachable: the app servers boot
  // fine without Postgres (connections are lazy), so a stopped container would
  // otherwise only surface as a runtime HTTPError on the first DB-touching
  // request, long after this script reports the session healthy.
  await assertDevInfraReady();

  const nodeDnsName = mode === "local" ? undefined : tailscale.resolveNodeDnsName();

  if (cliOptions.restart) {
    tailscale.cleanupExternalRoutes({ previousRoutes: previous?.externalRoutes, sharedPorts });
    teardownExistingSessions(tmuxStore, [identity.sessionName, previous?.sessionName ?? ""]);
  } else if (tmuxStore.sessionExists(identity.sessionName)) {
    const runningMode = isDevMode(previous?.mode) ? previous.mode : mode;
    const runningSharedPorts = resolveSharedDevServicePorts({
      mode: runningMode,
      worktreeKey: repoRootRealpath,
      services: sharedServiceNamesForMode(runningMode),
    });
    const runningDevCommand = createDevSessionCommand({
      mode: runningMode,
      sharedPorts: runningSharedPorts,
      worktreePrefix,
    });
    await printExistingSessionInfo({
      tmuxStore,
      sessionName: identity.sessionName,
      mode: runningMode,
      worktreePrefix,
      tailscale,
      sharedPorts: runningSharedPorts,
      nodeDnsName: runningMode === mode ? nodeDnsName : tailscale.resolveNodeDnsName(),
      branch: previous?.branch ?? branchName,
      displayCommand: runningDevCommand.display,
      createdAt: previous?.createdAt,
    });
    return;
  } else if (previous?.sessionName && tmuxStore.sessionExists(previous.sessionName)) {
    const runningMode = isDevMode(previous.mode) ? previous.mode : mode;
    const runningSharedPorts = resolveSharedDevServicePorts({
      mode: runningMode,
      worktreeKey: repoRootRealpath,
      services: sharedServiceNamesForMode(runningMode),
    });
    const runningDevCommand = createDevSessionCommand({
      mode: runningMode,
      sharedPorts: runningSharedPorts,
      worktreePrefix: previousWorktreePrefix,
    });
    await printExistingSessionInfo({
      tmuxStore,
      sessionName: previous.sessionName,
      mode: runningMode,
      worktreePrefix: previousWorktreePrefix,
      tailscale,
      sharedPorts: runningSharedPorts,
      nodeDnsName: runningMode === mode ? nodeDnsName : tailscale.resolveNodeDnsName(),
      branch: previous.branch,
      displayCommand: runningDevCommand.display,
      createdAt: previous.createdAt,
    });
    return;
  }

  await tailscale.pruneStaleRoutes();

  const createResult = tmuxStore.createSession(identity.sessionName);
  if (createResult.status !== 0) {
    console.error(
      createResult.stderr.trim() || `failed to create tmux session '${identity.sessionName}'`,
    );
    process.exit(createResult.status ?? 1);
  }

  const runResult = tmuxStore.sendKeys(identity.sessionName, devCommand.executable);
  if (runResult.status !== 0) {
    console.error(runResult.stderr.trim() || "failed to start portless in tmux");
    process.exit(runResult.status ?? 1);
  }

  const routeState = waitForPortlessState(tmuxStore, mode, 20_000, worktreePrefix);
  if (!routeState.healthy) {
    failAndExit(
      `dev session started but health checks failed: ${routeState.errors.join("; ")}`,
      "inspect logs/routes and restart with pnpm dev --restart",
      identity.sessionName,
      routeState.lines,
    );
  }

  const readiness = await waitForDevReadiness({
    origins: routeState.serviceOrigins,
    timeoutMs: 20_000,
  });
  if (!readiness.ok) {
    failAndExit(
      `dev session started but readiness checks failed: ${readiness.errors.join("; ")}`,
      "inspect logs/routes and restart with pnpm dev --restart",
      identity.sessionName,
      routeState.lines,
    );
  }

  let externalRoutes: ExternalDevRoute[];
  try {
    externalRoutes = tailscale.ensureExternalRoutes({ sharedPorts, nodeDnsName });
  } catch (error) {
    writeMetadataWithoutExternalRoutes({
      branch: branchName,
      sessionName: identity.sessionName,
      mode,
      displayCommand: devCommand.display,
    });
    failAndExit(
      `dev session started but Tailscale route verification failed: ${error instanceof Error ? error.message : String(error)}`,
      "inspect tailscale serve/funnel status and restart with pnpm dev --restart",
      identity.sessionName,
      routeState.lines,
    );
  }

  const verifiedRouteState = readPortlessState(tmuxStore, mode, worktreePrefix, externalRoutes);

  writeJsonMetadata(
    buildMetadata({
      branch: branchName,
      sessionName: identity.sessionName,
      mode,
      displayCommand: devCommand.display,
      externalRoutes,
    }),
  );

  printSessionInfo({
    headline: "started",
    sessionName: identity.sessionName,
    mode,
    routeLines: verifiedRouteState.lines,
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
