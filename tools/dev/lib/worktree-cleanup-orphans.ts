/** Reclaim managed dev sessions whose checkout directory has disappeared. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionIdentity } from "../session-identity";
import { parseGitWorktreePorcelain } from "./worktree-cleanup";

interface Pane {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly worktreePath: string;
  readonly pid: number;
  readonly cwd: string;
}

export interface OrphanDevSession {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly worktreePath: string;
  readonly panePids: readonly number[];
}

interface ProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly uid: number;
  readonly started: string;
  readonly command: string;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
}

function missingDirectory(directory: string): boolean {
  try {
    // A dangling symlink or an inaccessible path is not deletion evidence.
    fs.lstatSync(directory);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.accessSync(path.dirname(directory), fs.constants.R_OK | fs.constants.X_OK);
    return true;
  }
}

function withoutDeletedMarker(value: string): string {
  return value.replace(/ \(deleted\)$/, "");
}

function within(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function listPanes(cwd: string): Pane[] {
  let output: string;
  try {
    output = run(
      "tmux",
      [
        "list-panes",
        "-a",
        "-F",
        "#{session_id}\t#{session_name}\t#{session_path}\t#{pane_pid}\t#{pane_current_path}",
      ],
      cwd,
    );
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string | Buffer };
    if (failure.code === "ENOENT") return [];
    // No server is normal; any other inspection failure must remain visible.
    if (
      /^(no server running on|error connecting to .* \(No such file or directory\))/m.test(
        String(failure.stderr),
      )
    )
      return [];
    throw error;
  }
  return output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sessionId, sessionName, worktreePath, pidText, paneCwd] = line.split("\t");
      const pid = Number(pidText);
      if (
        !sessionId ||
        !sessionName ||
        !worktreePath ||
        !paneCwd ||
        !Number.isSafeInteger(pid) ||
        pid <= 1
      ) {
        throw new Error("Could not inspect tmux pane ownership");
      }
      return {
        sessionId,
        sessionName,
        worktreePath: withoutDeletedMarker(worktreePath),
        pid,
        cwd: withoutDeletedMarker(paneCwd),
      };
    });
}

/** Missing unregistered checkouts must be in this repository's sibling worktree root. */
export function collectOrphanDevSessions(cwd: string): OrphanDevSession[] {
  const worktrees = parseGitWorktreePorcelain(run("git", ["worktree", "list", "--porcelain"], cwd));
  const primary = worktrees[0];
  if (!primary) throw new Error("Could not resolve primary worktree");
  const primaryPath = fs.realpathSync(primary.path);
  const siblingRoot = `${primaryPath}.worktrees`;
  const registered = new Map(worktrees.map((worktree) => [path.resolve(worktree.path), worktree]));
  const sessions = new Map<string, Pane[]>();
  for (const pane of listPanes(cwd)) {
    const panes = sessions.get(pane.sessionId) ?? [];
    panes.push(pane);
    sessions.set(pane.sessionId, panes);
  }

  const orphans: OrphanDevSession[] = [];
  for (const panes of sessions.values()) {
    const first = panes[0];
    if (!first || !path.isAbsolute(first.worktreePath)) continue;
    const root = path.resolve(first.worktreePath);
    const worktree = registered.get(root);
    if (root === primaryPath || worktree?.locked) continue;
    if (!worktree && path.dirname(root) !== siblingRoot) continue;
    const hash = resolveSessionIdentity({ branchName: "", repoRootRealpath: root }).worktreeHash;
    if (!new RegExp(`^meridian-[a-z0-9-]+-${hash}$`).test(first.sessionName)) continue;
    // Never kill a multi-pane session with a pane that has moved into another checkout.
    if (panes.some((pane) => pane.worktreePath !== root || !within(pane.cwd, root))) continue;
    if (!missingDirectory(root)) continue;
    orphans.push({
      sessionId: first.sessionId,
      sessionName: first.sessionName,
      worktreePath: root,
      panePids: panes.map((pane) => pane.pid),
    });
  }
  return orphans;
}

function processes(cwd: string): ProcessIdentity[] {
  return run("ps", ["-axo", "pid=,ppid=,uid=,stat=,lstart=,comm="], cwd)
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/,
      );
      if (!match) throw new Error(`Could not parse process identity: ${line}`);
      const [, pid, parentPid, uid, state, started, command] = match;
      if (state?.startsWith("Z")) return [];
      return [
        {
          pid: Number(pid),
          parentPid: Number(parentPid),
          uid: Number(uid),
          started: started ?? "",
          command: command ?? "",
        },
      ];
    });
}

function descendants(
  roots: readonly number[],
  snapshot: readonly ProcessIdentity[],
): ProcessIdentity[] {
  const owned = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of snapshot) {
      if (owned.has(entry.parentPid) && !owned.has(entry.pid)) {
        owned.add(entry.pid);
        changed = true;
      }
    }
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Could not inspect current user ownership");
  const selected = snapshot.filter((entry) => owned.has(entry.pid));
  if (selected.some((entry) => entry.uid !== uid || entry.pid <= 1 || entry.pid === process.pid)) {
    throw new Error("Refusing to signal processes without same-user dev-session ownership");
  }
  return selected;
}

function surviving(captured: readonly ProcessIdentity[], cwd: string): ProcessIdentity[] {
  const current = new Map(processes(cwd).map((entry) => [entry.pid, entry]));
  return captured.filter((entry) => {
    const now = current.get(entry.pid);
    return now?.uid === entry.uid && now.started === entry.started && now.command === entry.command;
  });
}

async function waitForExit(
  captured: readonly ProcessIdentity[],
  cwd: string,
): Promise<ProcessIdentity[]> {
  const deadline = Date.now() + 1_000;
  let remaining = surviving(captured, cwd);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = surviving(remaining, cwd);
  }
  return remaining;
}

function signalProcesses(
  entries: readonly ProcessIdentity[],
  signal: NodeJS.Signals,
  orphan: OrphanDevSession,
  log: (line: string) => void,
): void {
  if (!missingDirectory(orphan.worktreePath))
    throw new Error(`Checkout reappeared: ${orphan.worktreePath}`);
  for (const entry of entries) {
    log(`${signal} PID ${entry.pid} (${entry.command})`);
    try {
      process.kill(entry.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

/** Snapshot descendants before killing tmux so reparented/setsid children stay owned. */
export async function stopOrphanDevSessions(
  cwd: string,
  plan: readonly OrphanDevSession[],
  log: (line: string) => void = console.log,
): Promise<void> {
  for (const orphan of plan) {
    const current = collectOrphanDevSessions(cwd).find(
      (entry) => entry.sessionId === orphan.sessionId,
    );
    if (
      !current ||
      current.sessionName !== orphan.sessionName ||
      current.worktreePath !== orphan.worktreePath ||
      current.panePids.join(",") !== orphan.panePids.join(",")
    ) {
      throw new Error(`Orphan session ownership changed: ${orphan.sessionName}`);
    }
    log(`Stopping orphan dev session ${orphan.sessionName} (${orphan.worktreePath})`);
    const captured = descendants(current.panePids, processes(cwd));
    signalProcesses(surviving(captured, cwd), "SIGTERM", orphan, log);
    let remaining = await waitForExit(captured, cwd);
    if (!missingDirectory(orphan.worktreePath))
      throw new Error(`Checkout reappeared: ${orphan.worktreePath}`);
    // Session IDs are exact tmux targets; never use a name-prefix match.
    const liveSession = listPanes(cwd).find((pane) => pane.sessionId === orphan.sessionId);
    if (liveSession) {
      if (liveSession.sessionName !== orphan.sessionName)
        throw new Error(`Session identity changed: ${orphan.sessionId}`);
      run("tmux", ["kill-session", "-t", orphan.sessionId], cwd);
    }
    remaining = surviving(remaining, cwd);
    signalProcesses(remaining, "SIGKILL", orphan, log);
    remaining = await waitForExit(remaining, cwd);
    if (remaining.length > 0)
      throw new Error(
        `Orphan processes survived: ${remaining.map((entry) => entry.pid).join(", ")}`,
      );
  }
  if (plan.length > 0) run("pnpm", ["exec", "portless", "prune"], cwd);
}
