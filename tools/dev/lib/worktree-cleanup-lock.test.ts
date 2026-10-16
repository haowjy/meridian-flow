import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCleanupLock } from "./worktree-cleanup-lock";

const lockDirs: string[] = [];

function freshLockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "meridian-cleanup-lock-"));
  lockDirs.push(dir);
  return join(dir, "meridian-prune.lock");
}

afterEach(() => {
  for (const dir of lockDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireCleanupLock", () => {
  it("refuses while a live holder owns the lock and frees it on release", () => {
    const lockPath = freshLockPath();
    const lock = acquireCleanupLock(lockPath);

    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
    expect(() => acquireCleanupLock(lockPath, { isAlive: () => true })).toThrow(
      /cleanup is running/,
    );

    lock.release();
    const reacquired = acquireCleanupLock(lockPath);
    reacquired.release();
  });

  it("takes over a lock whose holder is gone or unreadable", () => {
    const staleLockPath = freshLockPath();
    writeFileSync(staleLockPath, "999999999\n");
    const takenOver = acquireCleanupLock(staleLockPath, { isAlive: () => false });
    expect(readFileSync(staleLockPath, "utf8").trim()).toBe(String(process.pid));
    takenOver.release();

    const garbageLockPath = freshLockPath();
    writeFileSync(garbageLockPath, "not-a-pid\n");
    const recovered = acquireCleanupLock(garbageLockPath);
    expect(readFileSync(garbageLockPath, "utf8").trim()).toBe(String(process.pid));
    recovered.release();
  });
});
