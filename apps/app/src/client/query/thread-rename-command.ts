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
 * to overwrite a newer one. The project thread list read is part of the same
 * fence: `beginThreadRename` cancels an in-flight list read, and a list
 * response captured before a rename moves is re-projected through
 * `applyThreadRenameFence` instead of restoring the pre-rename row.
 */

import type { ThreadListItem } from "@meridian/contracts/protocol";
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

/** The authoritative thread list is the header projection; refetch it fenced. */
function invalidateThreadList(client: QueryClient, projectId: string): void {
  void client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId), exact: true });
}

/**
 * A snapshot of every live rename revision for a project. A list read captures
 * this before dispatch and compares it when the response lands, so a response
 * that predates a rename cannot restore the old title.
 */
export type ThreadRenameFence = ReadonlyMap<
  string,
  { revision: number; confirmedRevision: number }
>;

export function captureThreadRenameFence(
  client: QueryClient,
  projectId: string,
): ThreadRenameFence {
  const snapshot = new Map<string, { revision: number; confirmedRevision: number }>();
  for (const query of client
    .getQueryCache()
    .findAll({ queryKey: projectQueryKeys.threadRenamePrefix(projectId) })) {
    const threadId = query.queryKey[3];
    const record = query.state.data as ThreadRenameRecord | undefined;
    if (typeof threadId !== "string" || !record || record.revision === 0) continue;
    snapshot.set(threadId, {
      revision: record.revision,
      confirmedRevision: record.confirmedRevision,
    });
  }
  return snapshot;
}

/**
 * Re-apply the newest known title to a list read whose rename fence moved. A
 * still-pending intent keeps its `desiredTitle`; a settled one keeps the
 * confirmed `baseTitle`. Rows whose record did not move pass through untouched
 * so the server stays authoritative.
 */
export function applyThreadRenameFence(
  client: QueryClient,
  projectId: string,
  threads: ThreadListItem[],
  fence: ThreadRenameFence,
): ThreadListItem[] {
  return threads.map((thread) => {
    const record = client.getQueryData<ThreadRenameRecord>(recordKey(projectId, thread.id));
    if (!record || record.revision === 0) return thread;
    const before = fence.get(thread.id);
    const moved =
      before === undefined ||
      before.revision !== record.revision ||
      before.confirmedRevision !== record.confirmedRevision;
    if (!moved) return thread;
    const title = record.pendingCount > 0 ? record.desiredTitle : record.baseTitle;
    return title === null ? thread : { ...thread, title };
  });
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
  // The list read is part of the fence: a response already in flight must not
  // land on top of the title this intent is about to project.
  void client.cancelQueries({ queryKey: projectQueryKeys.threads(projectId), exact: true });
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
 *
 * Only the latest intent that leaves no other rename in flight invalidates the
 * authoritative list and feeds; an older settlement must not start a refetch
 * that can race a newer projection.
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
  writeRecord(client, projectId, threadId, {
    ...current,
    baseTitle: revision >= current.confirmedRevision ? title : current.baseTitle,
    confirmedRevision: Math.max(current.confirmedRevision, revision),
    pendingCount,
    failure: isLatest ? undefined : current.failure,
  });
  if (!isLatest) return false;
  projectTitle(client, threadId, title);
  if (pendingCount === 0) {
    invalidateThreadList(client, projectId);
    invalidateThreadTitleFeeds(client, projectId);
  }
  return true;
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
 * thread list instead of treating the write as rejected. The refresh is fenced
 * and only starts once the latest intent is the only one left.
 */
export function reconcileThreadRename(
  client: QueryClient,
  context: ThreadRenameMutationContext,
  error: Error,
): void {
  const { projectId, threadId, revision } = context;
  const current = readThreadRenameRecord(client, projectId, threadId);
  const isLatest = revision === current.revision;
  const pendingCount = Math.max(0, current.pendingCount - 1);
  writeRecord(client, projectId, threadId, {
    ...current,
    pendingCount,
    failure: isLatest ? { kind: "ambiguous", error } : current.failure,
  });
  if (isLatest && pendingCount === 0) {
    invalidateThreadList(client, projectId);
    invalidateThreadTitleFeeds(client, projectId);
  }
}

/**
 * Route teardown for a non-latest abort: drop the intent quietly, no
 * writer-visible refusal, and do not refetch a list the caller is leaving.
 */
export function abandonThreadRename(
  client: QueryClient,
  context: ThreadRenameMutationContext,
): void {
  const { projectId, threadId, revision } = context;
  const current = readThreadRenameRecord(client, projectId, threadId);
  const isLatest = revision === current.revision;
  const pendingCount = Math.max(0, current.pendingCount - 1);
  writeRecord(client, projectId, threadId, {
    ...current,
    pendingCount,
    failure: isLatest ? undefined : current.failure,
  });
}

/**
 * Account replacement drops the whole record and its projection. The epoch
 * aborted before the request settled, so the old account's optimistic title
 * must not linger in the shared client or be announced on the new lifetime.
 */
export function discardThreadRename(
  client: QueryClient,
  projectId: string,
  threadId: string,
): void {
  const current = readThreadRenameRecord(client, projectId, threadId);
  if (current.revision > 0) projectTitle(client, threadId, current.baseTitle);
  writeRecord(client, projectId, threadId, emptyThreadRenameRecord);
}
