import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyModeEnv, type DevMode, parseDevCliOptions } from "./dev-mode";
import { printFailure, printSessionInfo } from "./dev-output";
import {
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
}

interface PortlessState {
  lines: string[];
  servicePids: Record<string, number>;
  healthy: boolean;
  errors: string[];
}

function runGit(args: string[]): string {
  const tmuxStore = new TmuxSessionStore(repoRoot);
  const result = tmuxStore.run("git", args);
  if (result.status !== 0) {
    return "";
  }
  return result.stdout.trim();
}

const DEFAULT_PORTLESS_BRANCHES = new Set(["main", "master"]);
const MAX_DNS_LABEL_LENGTH = 63;

function truncateDnsLabel(label: string): string {
  if (label.length <= MAX_DNS_LABEL_LENGTH) return label;
  const hash = createHash("sha256").update(label).digest("hex").slice(0, 6);
  const head = label.slice(0, MAX_DNS_LABEL_LENGTH - 7).replace(/-+$/, "");
  return `${head}-${hash}`;
}

function sanitizeForHostname(value: string): string {
  return truncateDnsLabel(
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-+|-+$/g, ""),
  );
}

function isLinkedWorktree(): boolean {
  const gitDir = runGit(["rev-parse", "--git-dir"]);
  const commonDir = runGit(["rev-parse", "--git-common-dir"]);
  if (!gitDir || !commonDir) return false;

  const resolvedGitDir = path.resolve(repoRoot, gitDir);
  const resolvedCommonDir = path.resolve(repoRoot, commonDir);
  return resolvedGitDir !== resolvedCommonDir;
}

function branchToPortlessPrefix(branchName: string): string | undefined {
  if (!branchName || branchName === "HEAD" || DEFAULT_PORTLESS_BRANCHES.has(branchName)) {
    return undefined;
  }

  const lastSegment = branchName.split("/").at(-1) ?? branchName;
  return sanitizeForHostname(lastSegment) || undefined;
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

function portlessEnvPrefix(shared: boolean): string {
  const shareKeys = ["PORTLESS_TAILSCALE", "PORTLESS_FUNNEL"];
  const commonKeys = [
    "PORTLESS_LAN",
    "PORTLESS_HTTPS",
    "PORTLESS_TLD",
    "PORTLESS_WILDCARD",
    "PORTLESS_SYNC_HOSTS",
    "PORTLESS_STATE_DIR",
  ];

  const passThroughKeys = shared ? [...shareKeys, ...commonKeys] : commonKeys;
  const assignments = passThroughKeys
    .filter((key) => process.env[key] !== undefined)
    .map((key) => `${key}=${shellQuote(process.env[key] ?? "")}`);

  return assignments.length > 0 ? `env ${assignments.join(" ")} ` : "";
}

function portlessShareFlag(mode: DevMode): string {
  if (mode === "funnel") return "--funnel";
  if (mode === "tailscale") return "--tailscale";
  return "";
}

const APP_ENV_PASSTHROUGH_KEYS = [
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "TEST_USER_EMAIL",
  "TEST_USER_PASSWORD",
  "TEST_USER_ID",
  "MODEL_PROVIDER",
  "MODEL_CALL_TIMEOUT_MS",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "MODEL_REQUEST_DEBUG_CAPTURE",
] as const;

function appEnvPassthroughExports(): string {
  const exports = APP_ENV_PASSTHROUGH_KEYS.filter((key) => process.env[key] !== undefined).map(
    (key) => `export ${key}=${shellQuote(process.env[key] ?? "")}`,
  );

  return exports.length > 0 ? `; ${exports.join("; ")}` : "";
}

function envSourcePreamble(): string {
  return `set -a; [ -f .env ] && . ./.env; set +a${appEnvPassthroughExports()}`;
}

function portlessCommandBody(mode: DevMode): string {
  const shareFlag = portlessShareFlag(mode);
  const services: Array<{ name: string; pkg: string; shared: boolean; sharedModeOnly?: boolean }> =
    [
      { name: "app.meridian", pkg: "@meridian/app", shared: true },
      { name: "server.meridian", pkg: "@meridian/server", shared: false },
      { name: "web.meridian", pkg: "@meridian/www", shared: true, sharedModeOnly: true },
    ];

  const commands = services
    .filter((service) => mode !== "local" || !service.sharedModeOnly)
    .map(({ name, pkg, shared }) => {
      const flag = shared && shareFlag ? ` ${shareFlag}` : "";
      return `${portlessEnvPrefix(shared)}pnpm exec portless run --name ${name}${flag} pnpm --filter ${pkg} dev`;
    });

  return `(${commands.map((command) => `${command} & sleep 2`).join("; ")}; wait)`;
}

function createPortlessCommand(mode: DevMode): string {
  return `mkdir -p logs && ${envSourcePreamble()} && ${portlessCommandBody(mode)} 2>&1 | tee ${logPath}`;
}

function readPortlessState(
  tmuxStore: TmuxSessionStore,
  mode: DevMode,
  worktreePrefix?: string,
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
    lines: formatDevRouteLines(result.stdout, mode, worktreePrefix),
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
): PortlessState {
  const deadline = Date.now() + timeoutMs;
  let state = readPortlessState(tmuxStore, mode, worktreePrefix);

  while (!state.healthy && Date.now() < deadline) {
    sleep(500);
    state = readPortlessState(tmuxStore, mode, worktreePrefix);
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
}: {
  branch: string;
  sessionName: string;
  mode: DevMode;
  command: string;
}): DevSessionMetadata {
  return {
    sessionName,
    mode,
    branch: branch || "detached",
    command,
    createdAt: new Date().toISOString(),
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
}: {
  sessionName: string;
  mode: DevMode;
  branch: string;
  worktreeHash: string;
  portlessCommand: string;
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

  const branchName = runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
  const detachedHeadRef = runGit(["rev-parse", "--short", "HEAD"]);
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
  const portlessCommand = createPortlessCommand(mode);

  if (cliOptions.print) {
    printDryRun({
      sessionName: identity.sessionName,
      mode,
      branch: branchName,
      worktreeHash: identity.worktreeHash,
      portlessCommand,
    });
    process.exit(0);
  }

  if (!tmuxStore.hasCommandOnPath("tmux")) {
    console.error("tmux is required but was not found on PATH. Install tmux and retry.");
    process.exit(1);
  }

  if (cliOptions.restart) {
    teardownExistingSessions(tmuxStore, [identity.sessionName, previous?.sessionName ?? ""]);
  } else if (tmuxStore.sessionExists(identity.sessionName)) {
    const runningMode = isDevMode(previous?.mode) ? previous.mode : mode;
    const routeState = waitForPortlessState(tmuxStore, runningMode, 5_000, worktreePrefix);
    printSessionInfo({
      headline: "already running",
      sessionName: identity.sessionName,
      mode: runningMode,
      routeLines: routeState.lines,
    });
    return;
  } else if (previous?.sessionName && tmuxStore.sessionExists(previous.sessionName)) {
    const runningMode = isDevMode(previous.mode) ? previous.mode : mode;
    const routeState = waitForPortlessState(tmuxStore, runningMode, 5_000, previousWorktreePrefix);
    printSessionInfo({
      headline: "already running",
      sessionName: previous.sessionName,
      mode: runningMode,
      routeLines: routeState.lines,
    });
    return;
  }

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

  const routeState = waitForPortlessState(tmuxStore, mode, 20_000, worktreePrefix);
  if (!routeState.healthy) {
    failAndExit(
      `dev session started but health checks failed: ${routeState.errors.join("; ")}`,
      "inspect logs/routes and restart with pnpm dev --restart",
      identity.sessionName,
      routeState.lines,
    );
  }

  writeJsonMetadata(
    buildMetadata({
      branch: branchName,
      sessionName: identity.sessionName,
      mode,
      command: portlessCommand,
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
