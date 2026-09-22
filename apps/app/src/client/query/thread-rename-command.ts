/**
 * thread-rename-command — QueryClient-scoped authority for the thread-title P1
 * command.
 *
 * A rename projects the requested title into the cached project thread list
 * immediately, then confirms it against `PATCH /api/threads/:id/title`. The
 * record stored at `projectQueryKeys.threadRename` carries the per-thread
 * revision fence, the last confirmed title (the revert target), and the
 * classified failure so the header can render pending, revert, or Retry.
 *
 * Overlap is serialized by TanStack's mutation `scope` (see `useRenameThread`);
 * the revision check here makes a late completion from an older intent unable
 * to overwrite a newer one. An ambiguous outcome retains the projection and
 * invalidates the thread list to reconcile instead of pretending rejection.
 */
import type { QueryClient } from "@tanstack/react-query";

import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import { projectQueryKeys } from "./project-query-keys";
import { patchThreadInProjectCaches, readProjectThreadList } from "./project-thread-cache";

export type ThreadRenameFailureKind = "rejected" | "ambiguous" | "abandoned";

export type ThreadRenameFailure = { kind: "rejected" | "ambiguous"; error: Error };

export type ThreadRenameRecord = {
  /** Last server-confirmed title; the value a rejection reverts to. */
  baseTitle: string | null;
  /** Latest requested title; the value Retry resubmits. */
  desiredTitle: string | null;
  /** Revision of the latest submitted intent. */
  revision: number;
  /** Highest confirmed revision; keeps a stale success from rewinding the base. */
  confirmedRevision: number;
  /** Number of submitted intents that have not settled. */
  pendingCount: number;
  failure?: ThreadRenameFailure;
};

export type ThreadRenameMutationContext = {
  projectId: string;
  threadId: string;
  revision: number;
};

export const emptyThreadRenameRecord: ThreadRenameRecord = {
  baseTitle: null,
  desiredTitle: null,
  revision: 0,
  confirmedRevision: 0,
  pendingCount: 0,
};

const recordKey = (projectId: string, threadId: string) =>
  projectQueryKeys.threadRename(projectId, threadId);

export function readThreadRenameRecord(
  client: QueryClient,
  projectId: string,
  threadId: string,
): ThreadRenameRecord {
  return (
    client.getQueryData<ThreadRenameRecord>(recordKey(projectId, threadId)) ??
    emptyThreadRenameRecord
  );
}

function writeRecord(
  client: QueryClient,
  projectId: string,
  threadId: string,
  record: ThreadRenameRecord,
): void {
  client.setQueryData(recordKey(projectId, threadId), record);
}

/** Current cached title for a thread, or null when the list has not loaded. */
export function readCachedThreadTitle(
  client: QueryClient,
  projectId: string,
  threadId: string,
): string | null {
  const list = readProjectThreadList(client, projectId);
  return list?.find((thread) => thread.id === threadId)?.title ?? null;
}

function projectTitle(client: QueryClient, threadId: string, title: string | null): void {
  patchThreadInProjectCaches(client, threadId, { title });
}

/**
 * Home and Work feeds read a separate projection. Refresh them rather than
 * patching a second cache by hand; inactive feeds are only marked stale.
 */
function invalidateThreadTitleFeeds(client: QueryClient, projectId: string): void {
  void client.invalidateQueries({ queryKey: projectQueryKeys.homeFeed(projectId), exact: true });
  void client.invalidateQueries({ queryKey: projectQueryKeys.workThreads(projectId) });
}

/**
 * Classify a failed write using the existing HTTP boundary. A 4xx refusal or a
 * non-retryable structured error proves the server rejected the write; anything
 * else (network loss, timeout, 5xx, abort) leaves the outcome unknown.
 */
export function classifyThreadRenameFailure(error: unknown): ThreadRenameFailureKind {
  if (error instanceof DOMException && error.name === "AbortError") return "abandoned";
  if (isMeridianApiError(error)) {
    if (error.retryable) return "ambiguous";
    if (error.status !== undefined && error.status >= 400 && error.status < 500) return "rejected";
    return "ambiguous";
  }
  if (error instanceof HttpResponseError) {
    return error.status >= 400 && error.status < 500 ? "rejected" : "ambiguous";
  }
  return "ambiguous";
}

/** Project the requested title immediately and stamp the intent's revision. */
export function beginThreadRename(
  client: QueryClient,
  projectId: string,
  threadId: string,
  title: string,
): ThreadRenameMutationContext {
  const current = readThreadRenameRecord(client, projectId, threadId);
  const baseTitle =
    current.pendingCount === 0
      ? readCachedThreadTitle(client, projectId, threadId)
      : current.baseTitle;
  const revision = current.revision + 1;
  writeRecord(client, projectId, threadId, {
    ...current,
    baseTitle,
    desiredTitle: title,
    revision,
    pendingCount: current.pendingCount + 1,
    failure: undefined,
  });
  projectTitle(client, threadId, title);
  return { projectId, threadId, revision };
}

/**
 * Settle a confirmed rename. Returns whether this was still the latest intent,
 * which gates the caller's success announcement.
 */
export function confirmThreadRename(
  client: QueryClient,
  context: ThreadRenameMutationContext,
  title: string,
): boolean {
  const { projectId, threadId, revision } = context;
  const current = readThreadRenameRecord(client, projectId, threadId);
  const isLatest = revision === current.revision;
  const pendingCount = Math.max(0, current.pendingCount - 1);
  const next: ThreadRenameRecord = {
    ...current,
    baseTitle: revision >= current.confirmedRevision ? title : current.baseTitle,
    confirmedRevision: Math.max(current.confirmedRevision, revision),
    pendingCount,
    failure: isLatest ? undefined : current.failure,
  };
  if (isLatest) {
    projectTitle(client, threadId, title);
    // Retire the record once the latest intent settles so a remount does not
    // replay the confirmation; the projected title lives in the thread list.
    writeRecord(client, projectId, threadId, pendingCount === 0 ? emptyThreadRenameRecord : next);
    invalidateThreadTitleFeeds(client, projectId);
    return true;
  }
  writeRecord(client, projectId, threadId, next);
  invalidateThreadTitleFeeds(client, projectId);
  return false;
}

/** Revert the projection to the last confirmed title and surface Retry. */
export function rejectThreadRename(
  client: QueryClient,
  context: ThreadRenameMutationContext,
  error: Error,
): void {
  const { projectId, threadId, revision } = context;
  const current = readThreadRenameRecord(client, projectId, threadId);
  const pendingCount = Math.max(0, current.pendingCount - 1);
  if (revision !== current.revision) {
    writeRecord(client, projectId, threadId, { ...current, pendingCount });
    return;
  }
  projectTitle(client, threadId, current.baseTitle);
  writeRecord(client, projectId, threadId, {
    ...current,
    pendingCount,
    failure: { kind: "rejected", error },
  });
}

/**
 * Retain the projection for an unknown outcome and refresh the authoritative
 * thread list instead of treating the write as rejected.
 */
export function reconcileThreadRename(
  client: QueryClient,
  context: ThreadRenameMutationContext,
  error: Error,
): void {
  const { projectId, threadId, revision } = context;
  const current = readThreadRenameRecord(client, projectId, threadId);
  const pendingCount = Math.max(0, current.pendingCount - 1);
  writeRecord(client, projectId, threadId, {
    ...current,
    pendingCount,
    failure: revision === current.revision ? { kind: "ambiguous", error } : current.failure,
  });
  void client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) });
  invalidateThreadTitleFeeds(client, projectId);
}

/** Route/account teardown: no writer-visible refusal, reconcile quietly. */
export function abandonThreadRename(
  client: QueryClient,
  context: ThreadRenameMutationContext,
): void {
  const { projectId, threadId, revision } = context;
  const current = readThreadRenameRecord(client, projectId, threadId);
  const pendingCount = Math.max(0, current.pendingCount - 1);
  writeRecord(client, projectId, threadId, {
    ...current,
    pendingCount,
    failure: revision === current.revision ? undefined : current.failure,
  });
  void client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) });
  invalidateThreadTitleFeeds(client, projectId);
}
