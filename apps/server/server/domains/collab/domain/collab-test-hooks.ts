/**
 * Test-only injection points on collab's production code (contract §16.1), so the DB
 * suites can interleave a reply's save with a draft's close. Production never installs
 * one; every point is a no-op then.
 */
export type CollabHookPoint = "save.afterWorkLock" | "discard.afterLeases";

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
