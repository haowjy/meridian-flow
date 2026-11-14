/**
 * Test-only injection points on the server's production code (contract §16.1), so the DB
 * suites can interleave fences (`test-support/lock-interleave.ts`) and the running-stack
 * probes can pause or crash a server at one (`test-hook-controller.ts`). Production
 * installs none; every point is a no-op then.
 */

const TEST_HOOK_POINTS = [
  // A tree list's admission (domains/context tree-list store), in step order. A kill at any
  // before `afterCommit` leaves neither the records nor the rows.
  "treeList.afterLock",
  "treeList.afterAppend",
  "treeList.afterLiveRows",
  "treeList.afterRows",
  "treeList.afterCommit",
  // Collab.
  "draft.ensure.afterDocumentLock",
  "draft.peer.afterDocumentLock",
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
  "apply.beforeCompile",
  "apply.beforeBoundary",
  "apply.afterLive",
  /** An inverse's capture read a document's live bytes and nothing after them. */
  "inverse.afterCaptureRead",
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
  /** A model edit's command has not claimed its id. */
  "command.beforeClaim",
  /** The command holds its claim and has run nothing of its effect. */
  "command.afterClaim",
  /** A model edit holds its destination's lock (the document, or the draft row) and has read nothing. */
  "command.afterLock",
  /** The effect ran and its outcome is stored; nothing has committed. */
  "command.beforeCommit",
  /** The command's transaction committed (a model edit's, or a top-level one's); the caller has not been answered. */
  "command.afterCommit",
  /** Recovery is about to resolve one open command call's key; its result block is not stored. */
  "recovery.beforeResolve",
  /** A model response is about to be stored under the run's lease. */
  "response.beforeStore",
  /** A tool result is about to be stored; the call ran, nothing of its block exists. */
  "block.beforeStore",
  /** A tool result's block row is written; its events and the transaction have not committed. */
  "block.duringStore",
  /** A tool result's block committed; the run has not moved to the next call. */
  "block.afterStore",
  /** The ask row exists as pending, before the asking turn settles and publishes it. */
  "ask.pending",
  /** An answer, result block, completed asking turn, and continuation committed together. */
  "ask.answer.afterCommit",
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
