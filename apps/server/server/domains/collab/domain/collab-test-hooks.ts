/**
 * Test-only injection points on collab's production code (contract §16.1), so the DB
 * suites can interleave a reply's save with a draft's close, or a change with a staged
 * Apply. Production never installs one; every point is a no-op then.
 *
 * Outside production a running server also honours a crash controller for the crash-and-resend
 * probes: `COLLAB_CRASH_AT=<point>` names a point and `COLLAB_CRASH_ARM=<file>` arms it. Reaching
 * the point while the file exists removes the file, then exits the process with 137, so the
 * restarted server finds no arm and runs normally.
 */
import { existsSync, unlinkSync } from "node:fs";

const COLLAB_HOOK_POINTS = [
  "save.afterWorkLock",
  "checkpoint.afterAuthorityRead",
  "discard.afterLeases",
  "discard.beforeRetirement",
  "access.afterLeases",
  "applyItems.beforeStaging",
  "applyItems.afterStaging",
  "applyItems.beforeContinue",
  /** A created document's retraction read its branches and holds no branch row yet. */
  "retract.beforeLocks",
  /** A retraction holds its branch rows and found no contribution; nothing is deleted yet. */
  "retract.afterRecheck",
  /** A branch append's transaction committed; its frame is not yet acknowledged. */
  "branch.append.afterCommit",
  /** A branch rewrite wrote its checkpoint; the transaction has not committed. */
  "branch.rewrite.beforeCommit",
] as const;
export type CollabHookPoint = (typeof COLLAB_HOOK_POINTS)[number];

export function isCollabHookPoint(point: string): point is CollabHookPoint {
  return (COLLAB_HOOK_POINTS as readonly string[]).includes(point);
}

const hooks = new Map<CollabHookPoint, () => Promise<void>>();

/** Installs a hook; the returned function removes it. */
export function setCollabHook(point: CollabHookPoint, hook: () => Promise<void>): () => void {
  hooks.set(point, hook);
  return () => {
    if (hooks.get(point) === hook) hooks.delete(point);
  };
}

/** Runs the hook installed at `point`, if any. */
export async function collabHook(point: CollabHookPoint): Promise<void> {
  crashIfArmed(point);
  await hooks.get(point)?.();
}

function crashIfArmed(point: CollabHookPoint): void {
  if (process.env.NODE_ENV === "production") return;
  const { COLLAB_CRASH_AT: at, COLLAB_CRASH_ARM: arm } = process.env;
  if (at !== point || !arm || !existsSync(arm)) return;
  unlinkSync(arm);
  process.exit(137);
}
