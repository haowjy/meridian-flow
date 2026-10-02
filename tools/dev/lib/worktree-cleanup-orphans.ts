/** Reclaim managed dev sessions whose checkout directory has disappeared. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionIdentity } from "../session-identity";
import { runGit } from "./dev-env";
import { stopOwnedProcessTree } from "./owned-process-tree";
import { type GitWorktree, parseGitWorktreePorcelain } from "./worktree-cleanup";

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

interface RepositoryWorktrees {
  readonly primaryPath: string;
  readonly registered: ReadonlyMap<string, GitWorktree>;
}

function runTmux(args: string[], cwd: string): string {
  return execFileSync("tmux", args, {
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

function listPanes(cwd: string): Pane[] {
  let output: string;
  try {
    output = runTmux(
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
  if (panes.some((pane) => pane.worktreePath !== root || !within(pane.cwd, root))) return;
  if (!orphanCheckout(root, repository)) return;
  return {
    sessionId: first.sessionId,
    sessionName: first.sessionName,
    worktreePath: root,
    panePids: panes.map((pane) => pane.pid),
  };
}

/** Missing unregistered checkouts must be in this repository's sibling worktree root. */
export function collectOrphanDevSessions(cwd: string): OrphanDevSession[] {
  const repository = repositoryWorktrees(cwd);
  const sessions = new Map<string, Pane[]>();
  for (const pane of listPanes(cwd)) {
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
  const panes = listPanes(cwd).filter((pane) => pane.sessionId === expected.sessionId);
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
          runTmux(["kill-session", "-t", orphan.sessionId], cwd);
        }
      },
      log,
    });
  }
}
