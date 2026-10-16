/**
 * One worktree cleanup executes at a time per repository.
 *
 * Containment evidence can name another worktree branch as the ref that keeps
 * the planned commit alive. Two overlapping cleanups could then each cite the
 * other's branch as their surviving ref and delete both, so execution takes an
 * exclusive lock and a second run refuses instead of racing.
 *
 * Acquisition publishes the holder's pid atomically: the pid is written to a
 * private temp file first and `link()`ed into place, which fails when the lock
 * exists, so a contender can never observe or replace a half-written lock. A
 * lock whose holder is gone (or unreadable) is deliberately NOT taken over:
 * replacing it safely would need an atomic compare primitive the filesystem
 * does not offer here, so the run refuses and names the file instead. Release
 * removes the lock only while it still carries this run's pid.
 */
import { existsSync, linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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
  if (!existsSync(lockPath)) return undefined;
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
  const pid = process.pid;
  const tempPath = `${lockPath}.${pid}.tmp`;

  writeFileSync(tempPath, `${pid}\n`);
  try {
    linkSync(tempPath, lockPath);
  } catch (error) {
    rmSync(tempPath, { force: true });
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = readHolderPid(lockPath);
    if (holder !== undefined && isAlive(holder)) {
      throw new Error(
        `Another worktree cleanup is running (pid ${holder}). Retry when it finishes.`,
      );
    }
    throw new Error(
      `Stale worktree cleanup lock at ${lockPath} (holder ${holder ?? "unreadable"} is not running). ` +
        "Delete the file once no cleanup is running, then retry.",
    );
  }
  rmSync(tempPath, { force: true });

  return {
    release: () => {
      // Only remove the lock while this run still owns it; a replaced lock
      // belongs to whoever replaced it.
      if (readHolderPid(lockPath) !== pid) return;
      rmSync(lockPath, { force: true });
    },
  };
}
