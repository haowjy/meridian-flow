/**
 * Test-only injection points on the server's production code (contract §16.1), so the DB
 * suites can interleave fences (`test-support/lock-interleave.ts`) and the running-stack
 * probes can pause or crash a server at one (`test-hook-controller.ts`). Production
 * installs none; every point is a no-op then.
 */

const TEST_HOOK_POINTS = [
  // Tree lifecycle.
  "absorb.beforeRepoint",
  "createInBranch.afterCandidateLock",
  "createLive.afterLease",
  "createLive.afterCandidateLock",
  "endUse.afterRevalidate",
  "moves.beforeInstall",
  "place.afterRevalidate",
  "split.beforeRepoint",
  // Collab.
  "draft.ensure.afterDocumentLock",
  "draft.peer.afterDocumentLock",
  "removal.afterClose",
  /** A reply's save has opened its transaction and taken no Work lock yet. */
  "save.beforeWorkLock",
  "save.afterWorkLock",
  /** A reply's save holds its live document locks and has not confirmed its grants. */
  "save.afterDocumentLock",
  "checkpoint.afterAuthorityRead",
  /** A Discard attempt has not entered its commit scope. */
  "discard.beforeCommitScope",
  /** A committed transaction's draft retirement (any cause: Discard, removal, branch close) is about to run. */
  "draft.beforeRetirement",
  /** A thread core's access, or a peer pull past its ensures, is about to read its drafts. */
  "draft.beforeAccess",
  "apply.beforeBoundary",
  "apply.afterLive",
  "applyItems.beforeStaging",
  "applyItems.afterStaging",
  /** A created document's retraction read its drafts and holds no draft row yet. */
  "retract.beforeLocks",
  /** A retraction holds its draft rows and found no contribution; nothing is deleted yet. */
  "retract.afterRecheck",
  /** An inverse attempt planned on its capture and has not entered its commit scope. */
  "inverse.beforeCommitScope",
  /**
   * An append inserted its rows and receipts and still holds the draft row; nothing has
   * committed. A crash here leaves neither.
   */
  "draft.append.beforeCommit",
  /** A writer frame's append committed; the frame is not yet acknowledged. */
  "draft.append.afterCommit",
  /** A draft rewrite wrote its checkpoint; the transaction has not committed. */
  "draft.rewrite.beforeCommit",
] as const;
export type TestHookPoint = (typeof TEST_HOOK_POINTS)[number];

export function isTestHookPoint(point: string): point is TestHookPoint {
  return (TEST_HOOK_POINTS as readonly string[]).includes(point);
}

const hooks = new Map<TestHookPoint, () => Promise<void>>();

/** Installs a hook; the returned function removes it. */
export function setTestHook(point: TestHookPoint, hook: () => Promise<void>): () => void {
  hooks.set(point, hook);
  return () => {
    if (hooks.get(point) === hook) hooks.delete(point);
  };
}

/** Runs the hook installed at `point`, if any. */
export async function testHook(point: TestHookPoint): Promise<void> {
  await hooks.get(point)?.();
}
