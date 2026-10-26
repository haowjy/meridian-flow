/**
 * Liveness and ownership gates for automatic worktree cleanup.
 *
 * Commit evidence authorizes deleting a ref; these checks independently prove
 * that an auto-selected checkout is not still being used.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_TMUX_SERVER, DEV_TMUX_SERVER } from "./dev-tmux-server";

const PRESERVABLE_EXECUTABLES = new Set([
  "bash",
  "sh",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "ksh93",
  "csh",
  "tcsh",
  "nu",
  "tmux",
]);

interface WorkItemWithTaskDir {
  readonly id: string;
  readonly taskDir?: string;
}

interface ProcessCwd {
  readonly pid: number;
  readonly cwd: string;
  readonly preservable: boolean;
}

interface ProcessWithHiddenCwd {
  readonly pid: number;
  readonly commandLine: readonly string[];
}

interface TmuxPane {
  readonly sessionName: string;
  readonly paneId: string;
  readonly cwd: string;
}

/**
 * Dev stacks live on their own server. The default server is still read, never
 * written, so a legacy stack or a user shell parked in a worktree keeps
 * blocking removal.
 */
const TMUX_SERVERS = [DEFAULT_TMUX_SERVER, DEV_TMUX_SERVER];

function tmuxSocketPath(server: string): string | undefined {
  const uid = process.getuid?.();
  if (uid === undefined) return undefined;
  // tmux falls back to TMPDIR when TMUX_TMPDIR is unset.
  const tmpdir = process.env.TMUX_TMPDIR || process.env.TMPDIR || "/tmp";
  return path.join(tmpdir, `tmux-${uid}`, server);
}

function tmuxServerIsLive(socketPath: string): boolean {
  try {
    return fs
      .readFileSync("/proc/net/unix", "utf8")
      .split(/\r?\n/)
      .some((line) => {
        const fields = line.trim().split(/\s+/);
        return (
          fields[3] === "00010000" &&
          fields[4] === "0001" &&
          fields[5] === "01" &&
          fields[7] === socketPath
        );
      });
  } catch {
    return false;
  }
}

interface LivenessSnapshot {
  readonly processCwds: readonly ProcessCwd[];
  readonly processesWithHiddenCwds: readonly ProcessWithHiddenCwd[];
  readonly tmuxPanes: readonly TmuxPane[];
  readonly inspectionFailures: readonly string[];
}

export interface AutoCleanupReadinessCollection {
  readonly decisions: ReadonlyMap<string, AutoCleanupReadinessDecision>;
  readonly caveats: readonly string[];
}

export interface AutoCleanupReadiness {
  readonly worktreePath: string;
  readonly warnings?: readonly string[];
}

/** Force permits managed shutdown first, then only shells/tmux may remain. */
export type CleanupReadinessPolicy = "idle" | "stop-managed" | "preserve-shells";

export type AutoCleanupReadinessDecision =
  | { readonly ready: true; readonly evidence: AutoCleanupReadiness }
  | { readonly ready: false; readonly reasons: readonly string[] };

export interface AutoCleanupReadinessInput {
  readonly worktreePath: string;
  readonly clean: boolean;
  readonly activeWorkItemIds: readonly string[];
  readonly liveDevSessionNames: readonly string[];
  readonly liveProcessIds: readonly number[];
  readonly liveProcessCommandLineIds: readonly number[];
  readonly inspectionFailures: readonly string[];
  readonly preservableProcessIds?: readonly number[];
  readonly preservedPaneDescriptions?: readonly string[];
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\/+$/, "");
}

function isWithinPath(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

export function autoCleanupReadinessKey(worktreePath: string): string {
  return normalizePath(worktreePath);
}

export function decideAutoCleanupReadiness(
  input: AutoCleanupReadinessInput,
  policy: CleanupReadinessPolicy = "idle",
): AutoCleanupReadinessDecision {
  const reasons: string[] = [];
  if (!input.clean) reasons.push("worktree has uncommitted changes");
  if (input.activeWorkItemIds.length > 0) {
    reasons.push(`active Meridian work items: ${input.activeWorkItemIds.join(", ")}`);
  }
  if (policy === "idle" && input.liveDevSessionNames.length > 0) {
    reasons.push(`live dev sessions: ${input.liveDevSessionNames.join(", ")}`);
  }
  const preserved = new Set(policy === "preserve-shells" ? input.preservableProcessIds : []);
  const blockingPids = input.liveProcessIds.filter((pid) => !preserved.has(pid));
  if (policy !== "stop-managed" && blockingPids.length > 0) {
    reasons.push(`live processes have cwd under worktree: ${blockingPids.join(", ")}`);
  }
  if (input.liveProcessCommandLineIds.length > 0) {
    reasons.push(
      `live processes reference worktree path: ${input.liveProcessCommandLineIds.join(", ")}`,
    );
  }
  reasons.push(...input.inspectionFailures);

  const warnings =
    policy === "preserve-shells"
      ? [
          ...input.liveProcessIds
            .filter((pid) => preserved.has(pid))
            .map(
              (pid) =>
                `shell/tmux PID ${pid} remains in ${input.worktreePath}; cd out after removal`,
            ),
          ...(input.preservedPaneDescriptions ?? []).map(
            (pane) => `tmux ${pane} remains in ${input.worktreePath}; cd out after removal`,
          ),
        ]
      : [];

  return reasons.length === 0
    ? {
        ready: true,
        evidence: {
          worktreePath: autoCleanupReadinessKey(input.worktreePath),
          ...(warnings.length ? { warnings } : {}),
        },
      }
    : { ready: false, reasons };
}

function currentUserProcessCwds(): {
  readonly entries: readonly ProcessCwd[];
  readonly hiddenEntries: readonly ProcessWithHiddenCwd[];
  readonly failures: readonly string[];
} {
  let procEntries: string[];
  try {
    procEntries = fs.readdirSync("/proc");
  } catch (error) {
    return {
      entries: [],
      hiddenEntries: [],
      failures: [`could not scan process cwd state: ${(error as Error).message}`],
    };
  }

  const uid = process.getuid?.();
  const entries: ProcessCwd[] = [];
  const hiddenEntries: ProcessWithHiddenCwd[] = [];
  const failures: string[] = [];
  for (const entry of procEntries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;

    if (uid !== undefined) {
      try {
        const status = fs.readFileSync(`/proc/${entry}/status`, "utf8");
        const processUid = Number(status.match(/^Uid:\s+(\d+)/m)?.[1]);
        if (processUid !== uid) continue;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        failures.push(`could not inspect process ${pid} ownership`);
        continue;
      }
    }

    try {
      const cwd = fs.readlinkSync(`/proc/${entry}/cwd`);
      let preservable = false;
      try {
        const executable = path.basename(fs.readlinkSync(`/proc/${entry}/exe`));
        preservable = PRESERVABLE_EXECUTABLES.has(executable);
      } catch {
        // Unknown executables remain blockers even with --force.
      }
      entries.push({ pid, cwd, preservable });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "EACCES" || code === "EPERM") {
        try {
          const commandLine = fs
            .readFileSync(`/proc/${entry}/cmdline`, "utf8")
            .split("\0")
            .filter(Boolean);
          hiddenEntries.push({ pid, commandLine });
        } catch (commandLineError) {
          if ((commandLineError as NodeJS.ErrnoException).code === "ENOENT") continue;
          hiddenEntries.push({ pid, commandLine: [] });
        }
        continue;
      }
      failures.push(`could not inspect process ${pid} cwd`);
    }
  }

  return { entries, hiddenEntries, failures };
}

function tmuxPanesOnServer(
  cwd: string,
  server: string,
): {
  readonly entries: readonly TmuxPane[];
  readonly failures: readonly string[];
} {
  const result = spawnSync(
    "tmux",
    ["-L", server, "list-panes", "-a", "-F", "#{session_name}\t#{pane_id}\t#{pane_current_path}"],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { entries: [], failures: [] };
  }
  if (result.status !== 0) {
    const socketPath = tmuxSocketPath(server);
    // A stale socket file is not a server; only a live socket makes the
    // failed query an inspection failure.
    if (socketPath && !tmuxServerIsLive(socketPath)) return { entries: [], failures: [] };
    const detail = `${result.stderr ?? ""}`.trim();
    const label = `'${server}'`;
    return {
      entries: [],
      failures: [
        `could not inspect tmux panes on the ${label} server${detail ? `: ${detail}` : ""}`,
      ],
    };
  }

  const entries = `${result.stdout ?? ""}`
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sessionName, paneId, paneCwd] = line.split("\t", 3);
      return sessionName && paneId && paneCwd ? { sessionName, paneId, cwd: paneCwd } : undefined;
    })
    .filter((entry): entry is TmuxPane => entry !== undefined);
  return { entries, failures: [] };
}

function tmuxPanes(cwd: string): {
  readonly entries: readonly TmuxPane[];
  readonly failures: readonly string[];
} {
  const entries: TmuxPane[] = [];
  const failures: string[] = [];
  for (const server of TMUX_SERVERS) {
    const result = tmuxPanesOnServer(cwd, server);
    entries.push(...result.entries);
    failures.push(...result.failures);
  }
  return { entries, failures };
}

function collectLivenessSnapshot(cwd: string): LivenessSnapshot {
  const processes = currentUserProcessCwds();
  const panes = tmuxPanes(cwd);
  return {
    processCwds: processes.entries,
    processesWithHiddenCwds: processes.hiddenEntries,
    tmuxPanes: panes.entries,
    inspectionFailures: [...processes.failures, ...panes.failures],
  };
}

function commandLineReferencesPath(commandLine: readonly string[], root: string): boolean {
  const normalizedRoot = autoCleanupReadinessKey(root);
  return commandLine.some((argument) => {
    if (argument.startsWith("file:")) {
      try {
        if (isWithinPath(fileURLToPath(argument), normalizedRoot)) return true;
      } catch {
        // A malformed file URI can still contain an ordinary path reference.
      }
    }

    let offset = argument.indexOf(normalizedRoot);
    while (offset >= 0) {
      const previous = argument[offset - 1];
      const next = argument[offset + normalizedRoot.length];
      const hasLeadingBoundary = previous === undefined || !/[A-Za-z0-9._~+@%/-]/.test(previous);
      const hasTrailingBoundary =
        next === undefined || next === "/" || !/[A-Za-z0-9._~+@%-]/.test(next);
      if (hasLeadingBoundary && hasTrailingBoundary) return true;
      offset = argument.indexOf(normalizedRoot, offset + 1);
    }
    return false;
  });
}

function readDevSessionName(worktreePath: string): {
  readonly sessionName?: string;
  readonly failure?: string;
} {
  const metadataPath = path.join(worktreePath, ".meridian", "dev-session.json");
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "sessionName" in parsed &&
      typeof parsed.sessionName === "string"
    ) {
      return { sessionName: parsed.sessionName };
    }
    return { failure: `could not validate ${metadataPath}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { failure: `could not read ${metadataPath}: ${(error as Error).message}` };
  }
}

function worktreeIsClean(worktreePath: string): {
  readonly clean: boolean;
  readonly failure?: string;
} {
  const result = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: worktreePath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || result.error) {
    const detail = `${result.stderr ?? ""}`.trim() || result.error?.message || "git status failed";
    return { clean: false, failure: `could not inspect worktree status: ${detail}` };
  }
  return { clean: `${result.stdout ?? ""}`.trim().length === 0 };
}

export function inspectCleanupCleanliness(worktreePath: string): AutoCleanupReadinessDecision {
  const status = worktreeIsClean(worktreePath);
  return decideAutoCleanupReadiness({
    worktreePath,
    clean: status.clean,
    activeWorkItemIds: [],
    liveDevSessionNames: [],
    liveProcessIds: [],
    liveProcessCommandLineIds: [],
    inspectionFailures: status.failure ? [status.failure] : [],
  });
}

function decideForWorktree(
  worktreePath: string,
  workItems: readonly WorkItemWithTaskDir[],
  liveness: LivenessSnapshot,
  policy: CleanupReadinessPolicy = "idle",
): AutoCleanupReadinessDecision {
  const normalizedPath = autoCleanupReadinessKey(worktreePath);
  const status = worktreeIsClean(worktreePath);
  const activeWorkItemIds = workItems
    .filter(
      (workItem) =>
        workItem.taskDir && autoCleanupReadinessKey(workItem.taskDir) === normalizedPath,
    )
    .map((workItem) => workItem.id);
  const metadata = readDevSessionName(worktreePath);
  const paneSessions = liveness.tmuxPanes
    .filter((pane) => isWithinPath(pane.cwd, normalizedPath))
    .map((pane) => pane.sessionName);
  const metadataSessionIsLive =
    metadata.sessionName &&
    liveness.tmuxPanes.some((pane) => pane.sessionName === metadata.sessionName)
      ? [metadata.sessionName]
      : [];
  const liveDevSessionNames = [...new Set([...paneSessions, ...metadataSessionIsLive])];
  const liveProcessIds = liveness.processCwds
    .filter((entry) => isWithinPath(entry.cwd, normalizedPath))
    .map((entry) => entry.pid)
    .sort((a, b) => a - b);
  const liveProcessCommandLineIds = liveness.processesWithHiddenCwds
    .filter((entry) => commandLineReferencesPath(entry.commandLine, normalizedPath))
    .map((entry) => entry.pid)
    .sort((a, b) => a - b);
  const inspectionFailures = [
    ...liveness.inspectionFailures,
    ...(status.failure ? [status.failure] : []),
    ...(metadata.failure ? [metadata.failure] : []),
  ];

  return decideAutoCleanupReadiness(
    {
      worktreePath: normalizedPath,
      clean: status.clean,
      activeWorkItemIds,
      liveDevSessionNames,
      liveProcessIds,
      liveProcessCommandLineIds,
      inspectionFailures,
      preservableProcessIds: liveness.processCwds
        .filter((entry) => entry.preservable)
        .map((entry) => entry.pid),
      preservedPaneDescriptions: liveness.tmuxPanes
        .filter((pane) => isWithinPath(pane.cwd, normalizedPath))
        .map((pane) => `${pane.sessionName} pane ${pane.paneId}`),
    },
    policy,
  );
}

export function inspectAutoCleanupReadiness(
  worktreePath: string,
  workItems: readonly WorkItemWithTaskDir[],
  policy: CleanupReadinessPolicy = "idle",
): AutoCleanupReadinessDecision {
  return decideForWorktree(worktreePath, workItems, collectLivenessSnapshot(worktreePath), policy);
}

export function collectAutoCleanupReadiness(
  worktreePaths: readonly string[],
  workItems: readonly WorkItemWithTaskDir[],
  cwd: string,
): AutoCleanupReadinessCollection {
  const liveness = collectLivenessSnapshot(cwd);
  const decisions = new Map(
    worktreePaths.map((worktreePath) => [
      autoCleanupReadinessKey(worktreePath),
      decideForWorktree(worktreePath, workItems, liveness),
    ]),
  );
  const unattributedHiddenCwdPids = liveness.processesWithHiddenCwds
    .filter(
      (process) =>
        !worktreePaths.some((worktreePath) =>
          commandLineReferencesPath(process.commandLine, worktreePath),
        ),
    )
    .map((process) => process.pid)
    .sort((a, b) => a - b);
  const caveats =
    unattributedHiddenCwdPids.length === 0
      ? []
      : [
          `could not inspect cwd for same-user processes not attributed to a worktree: ${unattributedHiddenCwdPids.join(", ")}`,
        ];
  return { decisions, caveats };
}
