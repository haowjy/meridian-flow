// keep: one cleanup at a time per repository, or two overlapping runs each cite the other's branch as their surviving ref and delete both; the lock publishes its pid with `link()`, which fails when it exists
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
      if (readHolderPid(lockPath) !== pid) return;
      rmSync(lockPath, { force: true });
    },
  };
}
