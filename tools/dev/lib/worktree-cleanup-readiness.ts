/**
 * Liveness and ownership gates for automatic worktree cleanup.
 *
 * Commit evidence authorizes deleting a ref; these checks independently prove
 * that an auto-selected checkout is not still being used.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface WorkItemWithTaskDir {
  readonly id: string;
  readonly taskDir?: string;
}

interface ProcessCwd {
  readonly pid: number;
  readonly cwd: string;
}

interface TmuxPane {
  readonly sessionName: string;
  readonly cwd: string;
}

interface LivenessSnapshot {
  readonly processCwds: readonly ProcessCwd[];
  readonly tmuxPanes: readonly TmuxPane[];
  readonly inspectionFailures: readonly string[];
}

export interface AutoCleanupReadiness {
  readonly worktreePath: string;
}

export type AutoCleanupReadinessDecision =
  | { readonly ready: true; readonly evidence: AutoCleanupReadiness }
  | { readonly ready: false; readonly reasons: readonly string[] };

export interface AutoCleanupReadinessInput {
  readonly worktreePath: string;
  readonly clean: boolean;
  readonly activeWorkItemIds: readonly string[];
  readonly liveDevSessionNames: readonly string[];
  readonly liveProcessIds: readonly number[];
  readonly inspectionFailures: readonly string[];
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
): AutoCleanupReadinessDecision {
  const reasons: string[] = [];
  if (!input.clean) reasons.push("worktree has uncommitted changes");
  if (input.activeWorkItemIds.length > 0) {
    reasons.push(`active Meridian work items: ${input.activeWorkItemIds.join(", ")}`);
  }
  if (input.liveDevSessionNames.length > 0) {
    reasons.push(`live dev sessions: ${input.liveDevSessionNames.join(", ")}`);
  }
  if (input.liveProcessIds.length > 0) {
    reasons.push(`live processes have cwd under worktree: ${input.liveProcessIds.join(", ")}`);
  }
  reasons.push(...input.inspectionFailures);

  return reasons.length === 0
    ? {
        ready: true,
        evidence: { worktreePath: autoCleanupReadinessKey(input.worktreePath) },
      }
    : { ready: false, reasons };
}

function currentUserProcessCwds(): {
  readonly entries: readonly ProcessCwd[];
  readonly failures: readonly string[];
} {
  let procEntries: string[];
  try {
    procEntries = fs.readdirSync("/proc");
  } catch (error) {
    return {
      entries: [],
      failures: [`could not scan process cwd state: ${(error as Error).message}`],
    };
  }

  const uid = process.getuid?.();
  const entries: ProcessCwd[] = [];
  const failures: string[] = [];
  const hiddenCwdPids: number[] = [];
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
      entries.push({ pid, cwd: fs.readlinkSync(`/proc/${entry}/cwd`) });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "EACCES" || code === "EPERM") {
        hiddenCwdPids.push(pid);
        continue;
      }
      failures.push(`could not inspect process ${pid} cwd`);
    }
  }
  if (hiddenCwdPids.length > 0) {
    failures.push(`could not inspect cwd for same-user processes: ${hiddenCwdPids.join(", ")}`);
  }

  return { entries, failures };
}

function tmuxPanes(cwd: string): {
  readonly entries: readonly TmuxPane[];
  readonly failures: readonly string[];
} {
  const result = spawnSync(
    "tmux",
    ["list-panes", "-a", "-F", "#{session_name}\t#{pane_current_path}"],
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
    const detail = `${result.stderr ?? ""}`.trim();
    if (/no server running|failed to connect to server/i.test(detail)) {
      return { entries: [], failures: [] };
    }
    return {
      entries: [],
      failures: [`could not inspect tmux dev sessions${detail ? `: ${detail}` : ""}`],
    };
  }

  const entries = `${result.stdout ?? ""}`
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sessionName, paneCwd] = line.split("\t", 2);
      return sessionName && paneCwd ? { sessionName, cwd: paneCwd } : undefined;
    })
    .filter((entry): entry is TmuxPane => entry !== undefined);
  return { entries, failures: [] };
}

function collectLivenessSnapshot(cwd: string): LivenessSnapshot {
  const processes = currentUserProcessCwds();
  const panes = tmuxPanes(cwd);
  return {
    processCwds: processes.entries,
    tmuxPanes: panes.entries,
    inspectionFailures: [...processes.failures, ...panes.failures],
  };
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

function decideForWorktree(
  worktreePath: string,
  workItems: readonly WorkItemWithTaskDir[],
  liveness: LivenessSnapshot,
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
  const inspectionFailures = [
    ...liveness.inspectionFailures,
    ...(status.failure ? [status.failure] : []),
    ...(metadata.failure ? [metadata.failure] : []),
  ];

  return decideAutoCleanupReadiness({
    worktreePath: normalizedPath,
    clean: status.clean,
    activeWorkItemIds,
    liveDevSessionNames,
    liveProcessIds,
    inspectionFailures,
  });
}

export function inspectAutoCleanupReadiness(
  worktreePath: string,
  workItems: readonly WorkItemWithTaskDir[],
): AutoCleanupReadinessDecision {
  return decideForWorktree(worktreePath, workItems, collectLivenessSnapshot(worktreePath));
}

export function collectAutoCleanupReadiness(
  worktreePaths: readonly string[],
  workItems: readonly WorkItemWithTaskDir[],
  cwd: string,
): ReadonlyMap<string, AutoCleanupReadinessDecision> {
  const liveness = collectLivenessSnapshot(cwd);
  return new Map(
    worktreePaths.map((worktreePath) => [
      autoCleanupReadinessKey(worktreePath),
      decideForWorktree(worktreePath, workItems, liveness),
    ]),
  );
}
