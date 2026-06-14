// @ts-nocheck
/**
 * optimistic-project — the template for client-led optimistic writes.
 *
 * Starts a project/thread (or independent chat) with a client-generated UUID,
 * navigates immediately, then defers the server create+send to the chat handoff
 * for reconcile. The canonical optimistic flow the composer/package surfaces use.
 */

import type { Project } from "@meridian/contracts/projects";
import type { Thread } from "@meridian/contracts/protocol";
import type { useNavigate } from "@tanstack/react-router";

import {
  markIndependentProject,
  type ProjectStoreActions,
  type ThreadStoreActions,
} from "@/client/stores";

import { deriveTitleFromMessage } from "./thread-title";

/** Placeholder owner for optimistic rows until the server response folds in. */
const OPTIMISTIC_OWNER_ID = "optimistic-local";

type NavigateFn = ReturnType<typeof useNavigate>;

export type StartProjectArgs = {
  /**
   * Initial user message (only present for the composer flow). When omitted,
   * a plain empty project + thread is created (package card flow).
   */
  text?: string;
  /** Mars agent slug for the optimistic thread (bound on server create). */
  currentAgent?: string;
  /** Display title — derived from `text` when omitted. */
  title?: string;
  projectActions: ProjectStoreActions;
  threadActions: ThreadStoreActions;
  navigate: NavigateFn;
  /** Stable reference time so optimistic timestamps match the loader's `now`. */
  now?: number;
};

function makeOptimisticProject(id: string, title: string, timestamp: string): Project {
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
 * Begin a new project + chat from the Home composer.
 *
 * Navigates to the project view immediately; the actual project + thread
 * creation and first message are deferred to the ChatView via the thread
 * store's pending-stream slot.
 */
export function startProjectFromComposer({
  text,
  title: providedTitle,
  currentAgent,
  projectActions,
  threadActions,
  navigate,
  now,
}: StartProjectArgs & { text: string }): { projectId: string; threadId: string } {
  const projectId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const title = providedTitle ?? deriveTitleFromMessage(text);

  projectActions.ensureProject(makeOptimisticProject(projectId, title, timestamp));
  threadActions.ensureThread(makeOptimisticThread(threadId, projectId, title, timestamp));
  threadActions.markHandoffPending(threadId);
  threadActions.markPendingCreation({ projectId, threadId });
  const optimisticUserTurn = threadActions.appendUserTurn(threadId, text);
  threadActions.markPendingStream(threadId, {
    deferredSend: {
      projectId,
      title,
      text,
      optimisticUserTurnId: optimisticUserTurn.id,
      ...(currentAgent ? { currentAgent } : {}),
    },
  });

  // Land on chat (not project home) so ChatView mounts and runs the deferred
  // server create via useThreadHandoff. Project home never mounts ChatScreen.
  void navigate({
    to: "/project/$projectId",
    params: { projectId },
    search: { thread: threadId },
  });

  return { projectId, threadId };
}

/**
 * Begin an independent chat — a thread the user experiences as project-less.
 *
 * Mechanically identical to {@link startProjectFromComposer} (a real project +
 * thread are created via the deferred-send handoff), but the project is marked
 * independent so it stays hidden from the project list, and we navigate to the
 * minimal-chrome `/chat/:threadId` surface instead of the full workspace. The
 * "Create project" action later promotes it. Empty `text` opens with the
 * composer focused (no first message).
 */
export function startIndependentChat({
  text,
  projectActions,
  threadActions,
  navigate,
  now,
}: StartProjectArgs): { projectId: string; threadId: string } {
  const projectId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();
  const trimmed = text?.trim() ?? "";
  const title = deriveTitleFromMessage(trimmed);

  projectActions.ensureProject(makeOptimisticProject(projectId, title, timestamp));
  threadActions.ensureThread(makeOptimisticThread(threadId, projectId, title, timestamp));
  markIndependentProject(projectId);
  threadActions.markPendingCreation({ projectId, threadId });

  let optimisticUserTurnId: string | undefined;
  if (trimmed) {
    threadActions.markHandoffPending(threadId);
    optimisticUserTurnId = threadActions.appendUserTurn(threadId, trimmed).id;
  }
  threadActions.markPendingStream(threadId, {
    deferredSend: {
      projectId,
      title,
      text: trimmed,
      ...(optimisticUserTurnId ? { optimisticUserTurnId } : {}),
    },
  });

  void navigate({ to: "/chat/$threadId", params: { threadId } });

  return { projectId, threadId };
}

/**
 * Begin a new empty project from a package card click. No first message;
 * the project view shows the composer focused for the user to type in.
 *
 * NOTE: Phase 1 has no package install — the slug is currently ignored. When
 * the package system lands, this is where we'd record the chosen package.
 */
export function startProjectFromPackage({
  title,
  projectActions,
  threadActions,
  navigate,
  now,
}: StartProjectArgs & { title: string }): { projectId: string; threadId: string } {
  const projectId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const timestamp = new Date(now ?? Date.now()).toISOString();

  projectActions.ensureProject(makeOptimisticProject(projectId, title, timestamp));
  threadActions.ensureThread(makeOptimisticThread(threadId, projectId, title, timestamp));
  threadActions.markPendingCreation({ projectId, threadId });
  // Empty-text deferred send: useThreadHandoff will create the project + thread
  // on the server but skip appendUserMessage. The composer is open and ready.
  threadActions.markPendingStream(threadId, {
    deferredSend: { projectId, title, text: "" },
  });

  void navigate({
    to: "/project/$projectId",
    params: { projectId },
    search: { thread: threadId },
  });

  return { projectId, threadId };
}
