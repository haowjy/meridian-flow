// @ts-nocheck
/**
 * optimistic-workbench — the template for client-led optimistic writes.
 *
 * Starts a workbench/thread (or independent chat) with a client-generated UUID,
 * navigates immediately, then defers the server create+send to the chat handoff
 * for reconcile. The canonical optimistic flow the composer/package surfaces use.
 */

import type { Thread } from "@meridian/contracts/protocol";
import type { Workbench } from "@meridian/contracts/workbenches";
import type { useNavigate } from "@tanstack/react-router";

import {
  markIndependentWorkbench,
  type ThreadStoreActions,
  type WorkbenchStoreActions,
} from "@/client/stores";

import { deriveTitleFromMessage } from "./thread-title";

/** Placeholder owner for optimistic rows until the server response folds in. */
const OPTIMISTIC_OWNER_ID = "optimistic-local";

type NavigateFn = ReturnType<typeof useNavigate>;

export type StartWorkbenchArgs = {
  /**
   * Initial user message (only present for the composer flow). When omitted,
   * a plain empty workbench + thread is created (package card flow).
   */
  text?: string;
  /** Mars agent slug for the optimistic thread (bound on server create). */
  currentAgent?: string;
  /** Display title — derived from `text` when omitted. */
  title?: string;
  workbenchActions: WorkbenchStoreActions;
  threadActions: ThreadStoreActions;
  navigate: NavigateFn;
  /** Stable reference time so optimistic timestamps match the loader's `now`. */
  now?: number;
};

function makeOptimisticWorkbench(id: string, title: string, timestamp: string): Workbench {
  return {
    id,
    userId: OPTIMISTIC_OWNER_ID,
    title,
    description: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
  };
}

function makeOptimisticThread(
  id: string,
  workbenchId: string,
  title: string,
  timestamp: string,
): Thread {
  return {
    id,
    workbenchId,
    workId: null,
    userId: OPTIMISTIC_OWNER_ID,
    kind: "primary",
    status: "idle",
    title,
    currentAgent: null,
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

/**
 * Begin a new workbench + chat from the Home composer.
 *
 * Navigates to the workbench view immediately; the actual workbench + thread
 * creation and first message are deferred to the ChatView via the thread
 * store's pending-stream slot.
 */
export function startWorkbenchFromComposer({
  text,
  title: providedTitle,
  currentAgent,
  workbenchActions,
  threadActions,
  navigate,
  now,
}: StartWorkbenchArgs & { text: string }): { workbenchId: string; threadId: string } {
  const workbenchId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const title = providedTitle ?? deriveTitleFromMessage(text);

  workbenchActions.ensureWorkbench(makeOptimisticWorkbench(workbenchId, title, timestamp));
  threadActions.ensureThread(makeOptimisticThread(threadId, workbenchId, title, timestamp));
  threadActions.markHandoffPending(threadId);
  threadActions.markPendingCreation({ workbenchId, threadId });
  const optimisticUserTurn = threadActions.appendUserTurn(threadId, text);
  threadActions.markPendingStream(threadId, {
    deferredSend: {
      workbenchId,
      title,
      text,
      optimisticUserTurnId: optimisticUserTurn.id,
      ...(currentAgent ? { currentAgent } : {}),
    },
  });

  // Land on chat (not workbench home) so ChatView mounts and runs the deferred
  // server create via useThreadHandoff. Workbench home never mounts ChatScreen.
  void navigate({
    to: "/workbench/$workbenchId",
    params: { workbenchId },
    search: { thread: threadId },
  });

  return { workbenchId, threadId };
}

/**
 * Begin an independent chat — a thread the user experiences as workbench-less.
 *
 * Mechanically identical to {@link startWorkbenchFromComposer} (a real workbench +
 * thread are created via the deferred-send handoff), but the workbench is marked
 * independent so it stays hidden from the workbench list, and we navigate to the
 * minimal-chrome `/chat/:threadId` surface instead of the full workspace. The
 * "Create workbench" action later promotes it. Empty `text` opens with the
 * composer focused (no first message).
 */
export function startIndependentChat({
  text,
  workbenchActions,
  threadActions,
  navigate,
  now,
}: StartWorkbenchArgs): { workbenchId: string; threadId: string } {
  const workbenchId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const trimmed = text?.trim() ?? "";
  const title = deriveTitleFromMessage(trimmed);

  workbenchActions.ensureWorkbench(makeOptimisticWorkbench(workbenchId, title, timestamp));
  threadActions.ensureThread(makeOptimisticThread(threadId, workbenchId, title, timestamp));
  markIndependentWorkbench(workbenchId);
  threadActions.markPendingCreation({ workbenchId, threadId });

  let optimisticUserTurnId: string | undefined;
  if (trimmed) {
    threadActions.markHandoffPending(threadId);
    optimisticUserTurnId = threadActions.appendUserTurn(threadId, trimmed).id;
  }
  threadActions.markPendingStream(threadId, {
    deferredSend: {
      workbenchId,
      title,
      text: trimmed,
      ...(optimisticUserTurnId ? { optimisticUserTurnId } : {}),
    },
  });

  void navigate({ to: "/chat/$threadId", params: { threadId } });

  return { workbenchId, threadId };
}

/**
 * Begin a new empty workbench from a package card click. No first message;
 * the workbench view shows the composer focused for the user to type in.
 *
 * NOTE: Phase 1 has no package install — the slug is currently ignored. When
 * the package system lands, this is where we'd record the chosen package.
 */
export function startWorkbenchFromPackage({
  title,
  workbenchActions,
  threadActions,
  navigate,
  now,
}: StartWorkbenchArgs & { title: string }): { workbenchId: string; threadId: string } {
  const workbenchId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();

  workbenchActions.ensureWorkbench(makeOptimisticWorkbench(workbenchId, title, timestamp));
  threadActions.ensureThread(makeOptimisticThread(threadId, workbenchId, title, timestamp));
  threadActions.markPendingCreation({ workbenchId, threadId });
  // Empty-text deferred send: useThreadHandoff will create the workbench + thread
  // on the server but skip appendUserMessage. The composer is open and ready.
  threadActions.markPendingStream(threadId, {
    deferredSend: { workbenchId, title, text: "" },
  });

  void navigate({
    to: "/workbench/$workbenchId",
    params: { workbenchId },
    search: { thread: threadId },
  });

  return { workbenchId, threadId };
}
