/**
 * Test-only injection points on collab's production code (contract §16.1), so the DB
 * suites can interleave a reply's save with a draft's close, or a change with a staged
 * Apply, and the crash-and-resend probes can stop a server at one
 * (`adapters/collab-crash-controller.ts`). Production installs none; every point is a
 * no-op then.
 */

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
  /** An inverse attempt planned on its capture and has not entered its commit scope. */
  "inverse.beforeCommitScope",
  /** A writer frame's append committed; the frame is not yet acknowledged. */
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
  await hooks.get(point)?.();
}
