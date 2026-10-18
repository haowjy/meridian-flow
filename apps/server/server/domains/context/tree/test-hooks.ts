/**
 * Test-only injection points on the tree module's production code (contract §16.1), so
 * the DB suites can interleave its fences. Production never installs one; every point is
 * a no-op then. Its own module so lifecycle files share it without importing each other.
 */
export type TreeHookPoint =
  | "absorb.beforeRepoint"
  | "createInBranch.afterCandidateLock"
  | "createLive.afterLease"
  | "createLive.afterCandidateLock"
  | "endUse.afterRevalidate"
  | "moves.beforeInstall"
  | "place.afterRevalidate"
  | "split.beforeRepoint";

const hooks = new Map<TreeHookPoint, () => Promise<void>>();

/** Installs a hook; the returned function removes it. */
export function setTreeHook(point: TreeHookPoint, hook: () => Promise<void>): () => void {
  hooks.set(point, hook);
  return () => {
    if (hooks.get(point) === hook) hooks.delete(point);
  };
}

/** Runs the hook installed at `point`, if any. */
export async function treeHook(point: TreeHookPoint): Promise<void> {
  await hooks.get(point)?.();
}
