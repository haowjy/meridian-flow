/**
 * deferred-project-chat — optimistic "new chat" inside an existing project.
 *
 * The thread row stays client-only until the first send: the composer agent picker
 * remains interactive, then `ChatView` creates the server thread with
 * `wireAgentSlug(selectedSlug)` on submit. Mirrors the Home deferral pattern but
 * skips project creation because the project already exists.
 */
import type { Thread } from "@meridian/contracts/protocol";

import type { ThreadStoreActions } from "@/client/stores";

const OPTIMISTIC_OWNER_ID = "optimistic-local";

function makeOptimisticThread(
  id: string,
  projectId: string,
  title: string,
  timestamp: string,
): Thread {
  return {
    id,
    projectId,
    workId: null,
    userId: OPTIMISTIC_OWNER_ID,
    kind: "primary",
    status: "idle",
    title,
    currentAgent: null,
    aiWriteMode: "direct",
    parentThreadId: null,
    rootThreadId: id,
    spawnDepth: 0,
    spawnStatus: null,
    totalCostUsd: "0",
    turnCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
}

export type StartDeferredProjectChatArgs = {
  projectId: string;
  threadActions: ThreadStoreActions;
  /** Provisional title — callers pass `defaultThreadTitle()` from the React layer. */
  title: string;
  /** Stable reference time so optimistic timestamps match route loaders. */
  now?: number;
};

export type StartDeferredProjectChatResult = {
  threadId: string;
};

/**
 * Synchronous latch for deferred project first-send (thread create + submit).
 * Prevents double-submit while the optimistic user turn is in flight.
 */
export class DeferredFirstSendLatch {
  private acquired = false;

  tryAcquire(): boolean {
    if (this.acquired) return false;
    this.acquired = true;
    return true;
  }

  release(): void {
    this.acquired = false;
  }

  get isAcquired(): boolean {
    return this.acquired;
  }
}

/**
 * Seed an optimistic thread and mark it pending server creation (thread only —
 * the project already exists, so do not gate `useProjectThreads`).
 */
export function startDeferredProjectChat({
  projectId,
  threadActions,
  title,
  now,
}: StartDeferredProjectChatArgs): StartDeferredProjectChatResult {
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();

  threadActions.ensureThread(makeOptimisticThread(threadId, projectId, title, timestamp));
  threadActions.markPendingCreation({ threadId });

  return { threadId };
}
