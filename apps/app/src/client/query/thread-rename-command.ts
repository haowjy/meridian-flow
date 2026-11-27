import type { ThreadListItem } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { HttpResponseError, isMeridianApiError } from "@/client/api/http-client";
import { patchChatRow } from "./chat-projections";
import { projectQueryKeys } from "./project-query-keys";
import { readProjectThreadList } from "./project-thread-cache";
import { writeOverReads } from "./write-over-reads";

export type ThreadRenameFailureKind = "rejected" | "ambiguous" | "abandoned";

export type ThreadRenameFailure = { kind: "rejected" | "ambiguous"; error: Error };

export type ThreadRenameRecord = {
  baseTitle: string | null;
  desiredTitle: string | null;
  revision: number;
  confirmedRevision: number;
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

export function readCachedThreadTitle(
  client: QueryClient,
  projectId: string,
  threadId: string,
): string | null {
  const list = readProjectThreadList(client, projectId);
  return list?.find((thread) => thread.id === threadId)?.title ?? null;
}

function projectTitle(
  client: QueryClient,
  projectId: string,
  threadId: string,
  title: string | null,
): void {
  patchChatRow(client, projectId, threadId, {
    threadListItem: (item) => ({ ...item, title }),
    projectChatItem: (item) => ({ ...item, title: title ?? "" }),
  });
}

function invalidateThreadList(client: QueryClient, projectId: string): void {
  void client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId), exact: true });
}

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

export function beginThreadRename(
  client: QueryClient,
  projectId: string,
  threadId: string,
  title: string,
): ThreadRenameMutationContext {
  return writeOverReads(client, [projectQueryKeys.threads(projectId)], () => {
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
    projectTitle(client, projectId, threadId, title);
    return { projectId, threadId, revision };
  });
}

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
  projectTitle(client, projectId, threadId, title);
  if (pendingCount === 0) {
    invalidateThreadList(client, projectId);
  }
  return true;
}

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
  projectTitle(client, projectId, threadId, current.baseTitle);
  writeRecord(client, projectId, threadId, {
    ...current,
    pendingCount,
    failure: { kind: "rejected", error },
  });
}

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
  }
}

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

export function discardThreadRename(
  client: QueryClient,
  projectId: string,
  threadId: string,
): void {
  const current = readThreadRenameRecord(client, projectId, threadId);
  if (current.revision > 0) projectTitle(client, projectId, threadId, current.baseTitle);
  writeRecord(client, projectId, threadId, emptyThreadRenameRecord);
}
