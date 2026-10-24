/**
 * Tests worktree cleanup lock behavior.
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - PID-file cleanup lock protocol
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireCleanupLock } from "./worktree-cleanup-lock";

const lockDirs: string[] = [];

function freshLock(): { dir: string; lockPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "meridian-cleanup-lock-"));
  lockDirs.push(dir);
  return { dir, lockPath: join(dir, "meridian-prune.lock") };
}

afterEach(() => {
  for (const dir of lockDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("acquireCleanupLock", () => {
  it("refuses while a live holder owns the lock and releases only its own lock", () => {
    const { dir, lockPath } = freshLock();
    const lock = acquireCleanupLock(lockPath, { isAlive: () => true });

    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(process.pid));
    expect(readdirSync(dir)).toEqual(["meridian-prune.lock"]);
    expect(() => acquireCleanupLock(lockPath, { isAlive: () => true })).toThrow(
      /cleanup is running/,
    );

    // A lock that now carries someone else's pid is left alone on release.
    writeFileSync(lockPath, "999999\n");
    lock.release();
    expect(readFileSync(lockPath, "utf8").trim()).toBe("999999");
    rmSync(lockPath, { force: true });

    const reacquired = acquireCleanupLock(lockPath, { isAlive: () => true });
    reacquired.release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a stale or unreadable lock instead of taking it over", () => {
    const stale = freshLock();
    writeFileSync(stale.lockPath, "999999999\n");
    expect(() => acquireCleanupLock(stale.lockPath, { isAlive: () => false })).toThrow(/Stale/);
    expect(existsSync(stale.lockPath)).toBe(true);
    expect(readdirSync(stale.dir)).toEqual(["meridian-prune.lock"]);

    const garbage = freshLock();
    writeFileSync(garbage.lockPath, "not-a-pid\n");
    expect(() => acquireCleanupLock(garbage.lockPath, { isAlive: () => true })).toThrow(/Stale/);
    expect(existsSync(garbage.lockPath)).toBe(true);
  });
});
