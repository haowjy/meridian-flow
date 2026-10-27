/**
 * Reclaim managed dev sessions whose checkout directory has disappeared.
 *
 * Reads and kills only on the private `meridian-dev` server. The default server
 * holds the machine owner's shells and is never touched here, so a stack
 * started there before dev moved is stopped by `pnpm dev --stop`, not reaped.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionIdentity } from "../session-identity";
import { runGit } from "./dev-env";
import { DEV_TMUX_CLIENT_CWD, devTmuxArgs } from "./dev-tmux-server";
import { stopOwnedProcessTree } from "./owned-process-tree";
import { type GitWorktree, parseGitWorktreePorcelain } from "./worktree-cleanup";

interface Pane {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly worktreePath: string;
  /**
   * Absent for a dead pane, which `remain-on-exit` keeps listed: it has no
   * process or cwd, and its PID may already belong to someone else.
   */
  readonly process?: { readonly pid: number; readonly cwd: string };
}

export interface OrphanDevSession {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly worktreePath: string;
  readonly panePids: readonly number[];
}

interface RepositoryWorktrees {
  readonly primaryPath: string;
  readonly registered: ReadonlyMap<string, GitWorktree>;
}

function runTmux(args: string[]): string {
  return execFileSync("tmux", devTmuxArgs(args), {
    cwd: DEV_TMUX_CLIENT_CWD,
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
    // The sibling worktree container may itself have been deleted. Walk to an
    // inspectable existing ancestor, refusing dangling symlinks along the way.
    let ancestor = path.dirname(directory);
    while (true) {
      try {
        if (!fs.lstatSync(ancestor).isDirectory()) return false;
        fs.accessSync(ancestor, fs.constants.R_OK | fs.constants.X_OK);
        return true;
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== "ENOENT") throw ancestorError;
        ancestor = path.dirname(ancestor);
      }
    }
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

function listPanes(): Pane[] {
  let output: string;
  try {
    output = runTmux([
      "list-panes",
      "-a",
      "-F",
      "#{session_id}\t#{session_name}\t#{session_path}\t#{pane_dead}\t#{pane_pid}\t#{pane_current_path}",
    ]);
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
  // No trim(): a dead pane's empty cwd is the line's last field.
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sessionId, sessionName, worktreePath, dead, pidText, paneCwd] = line.split("\t");
      if (!sessionId || !sessionName || !worktreePath || (dead !== "0" && dead !== "1")) {
        throw new Error("Could not inspect tmux pane ownership");
      }
      const session = {
        sessionId,
        sessionName,
        worktreePath: withoutDeletedMarker(worktreePath),
      };
      if (dead === "1") return session;
      const pid = Number(pidText);
      if (!paneCwd || !Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error("Could not inspect tmux pane ownership");
      }
      return { ...session, process: { pid, cwd: withoutDeletedMarker(paneCwd) } };
    });
}

function repositoryWorktrees(cwd: string): RepositoryWorktrees {
  const worktrees = parseGitWorktreePorcelain(runGit(cwd, ["worktree", "list", "--porcelain"]));
  const primary = worktrees[0];
  if (!primary) throw new Error("Could not resolve primary worktree");
  return {
    primaryPath: fs.realpathSync(primary.path),
    registered: new Map(worktrees.map((worktree) => [path.resolve(worktree.path), worktree])),
  };
}

function orphanCheckout(root: string, repository: RepositoryWorktrees): boolean {
  const worktree = repository.registered.get(root);
  if (root === repository.primaryPath || worktree?.locked) return false;
  if (!worktree && path.dirname(root) !== `${repository.primaryPath}.worktrees`) return false;
  return missingDirectory(root);
}

function orphanSession(
  panes: readonly Pane[],
  repository: RepositoryWorktrees,
): OrphanDevSession | undefined {
  const first = panes[0];
  if (!first || !path.isAbsolute(first.worktreePath)) return;
  const root = path.resolve(first.worktreePath);
  const hash = resolveSessionIdentity({ branchName: "", repoRootRealpath: root }).worktreeHash;
  if (!new RegExp(`^meridian-[a-z0-9-]+-${hash}$`).test(first.sessionName)) return;
  // A dead pane proves nothing about where work happens and holds nothing to
  // kill, so only live panes need to sit inside the missing checkout. A session
  // of dead panes is reaped on its name, path and checkout evidence alone.
  if (
    panes.some(
      (pane) => pane.worktreePath !== root || (pane.process && !within(pane.process.cwd, root)),
    )
  )
    return;
  if (!orphanCheckout(root, repository)) return;
  return {
    sessionId: first.sessionId,
    sessionName: first.sessionName,
    worktreePath: root,
    panePids: panes.flatMap((pane) => (pane.process ? [pane.process.pid] : [])),
  };
}

/** Missing unregistered checkouts must be in this repository's sibling worktree root. */
export function collectOrphanDevSessions(cwd: string): OrphanDevSession[] {
  const repository = repositoryWorktrees(cwd);
  const sessions = new Map<string, Pane[]>();
  for (const pane of listPanes()) {
    const panes = sessions.get(pane.sessionId) ?? [];
    panes.push(pane);
    sessions.set(pane.sessionId, panes);
  }
  return [...sessions.values()].flatMap((panes) => {
    const orphan = orphanSession(panes, repository);
    return orphan ? [orphan] : [];
  });
}

function inspectPlannedSession(
  cwd: string,
  expected: OrphanDevSession,
): OrphanDevSession | undefined {
  const repository = repositoryWorktrees(cwd);
  const refuse = () => {
    throw new Error(`Orphan session ownership changed: ${expected.sessionName}`);
  };
  if (!orphanCheckout(expected.worktreePath, repository)) refuse();
  const panes = listPanes().filter((pane) => pane.sessionId === expected.sessionId);
  // TERM may remove some or all original panes. New or relocated panes are not
  // authorized by the plan, even if the session ID and name have not changed.
  if (panes.length === 0) return;
  const current = orphanSession(panes, repository);
  if (
    !current ||
    current.sessionName !== expected.sessionName ||
    current.worktreePath !== expected.worktreePath ||
    current.panePids.some((pid) => !expected.panePids.includes(pid))
  )
    refuse();
  return current;
}

/** Revalidate the same ownership contract before every shutdown phase. */
export async function stopOrphanDevSessions(
  cwd: string,
  plan: readonly OrphanDevSession[],
  log: (line: string) => void = console.log,
): Promise<void> {
  for (const orphan of plan) {
    const current = inspectPlannedSession(cwd, orphan);
    if (!current) continue;
    log(`Stopping orphan dev session ${orphan.sessionName} (${orphan.worktreePath})`);
    await stopOwnedProcessTree({
      cwd,
      roots: current.panePids,
      assertOwnership: () => {
        inspectPlannedSession(cwd, orphan);
      },
      teardown: () => {
        if (inspectPlannedSession(cwd, orphan)) {
          // Session IDs are exact tmux targets; never use a name-prefix match.
          runTmux(["kill-session", "-t", orphan.sessionId]);
        }
      },
      log,
    });
  }
}
