/**
 * Test-only injection points on collab's production code (contract §16.1), so the DB
 * suites can interleave a reply's save with a draft's close, or a change with a staged
 * Apply, and the crash-and-resend probes can stop a server at one
 * (`adapters/collab-hook-controller.ts`). Production installs none; every point is a
 * no-op then.
 */

const COLLAB_HOOK_POINTS = [
  /** A reply's save has opened its transaction and taken no Work lock yet. */
  "save.beforeWorkLock",
  "save.afterWorkLock",
  /** A reply's save holds its live document locks and has not confirmed its grants. */
  "save.afterDocumentLock",
  "checkpoint.afterAuthorityRead",
  /** A Discard attempt has not entered its commit scope. */
  "discard.beforeCommitScope",
  "discard.beforeRetirement",
  /** A thread core's access, or a peer pull past its ensures, is about to read its drafts. */
  "draft.beforeAccess",
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
