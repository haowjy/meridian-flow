/**
 * One worktree cleanup executes at a time per repository.
 *
 * Containment evidence can name another worktree branch as the ref that keeps
 * the planned commit alive. Two overlapping cleanups could then each cite the
 * other's branch as their surviving ref and delete both, leaving the commit
 * with no ref at all, so execution takes an exclusive lock and a second run
 * refuses instead of racing. The lock file records the holder's pid; a file
 * whose pid is gone is stale and is taken over.
 */
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

export interface CleanupLock {
  release(): void;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolderPid(lockPath: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function acquireCleanupLock(
  lockPath: string,
  options: { readonly isAlive?: (pid: number) => boolean } = {},
): CleanupLock {
  const isAlive = options.isAlive ?? processIsAlive;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return { release: () => rmSync(lockPath, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readHolderPid(lockPath);
      if (holder !== undefined && isAlive(holder)) {
        throw new Error(
          `Another worktree cleanup is running (pid ${holder}). Retry when it finishes; ` +
            `if it is gone, delete ${lockPath}.`,
        );
      }
      // Stale holder (crashed, or the pid was recycled away): take it over.
      rmSync(lockPath, { force: true });
    }
  }

  throw new Error(`Could not acquire the worktree cleanup lock at ${lockPath}.`);
}
