/**
 * Test-only injection points on collab's production code (contract §16.1), so the DB
 * suites can interleave a reply's save with a draft's close, or a change with a staged
 * Apply. Production never installs one; every point is a no-op then.
 */
const COLLAB_HOOK_POINTS = [
  "save.afterWorkLock",
  "discard.afterLeases",
  "access.afterLeases",
  "applyItems.afterLinkCut",
  "applyItems.afterStaging",
  "applyItems.beforeContinue",
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
