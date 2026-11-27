import type {
  ListWorksResponse,
  ThreadListItem,
  ThreadSnapshotResponse,
} from "@meridian/contracts/protocol";
import type {
  RebindThreadWorkResponse,
  WorkContextProjectionSignal,
} from "@meridian/contracts/works";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { invalidateProjectChatFeed } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";
import { patchThreadInProjectCaches } from "./project-thread-cache";
import { threadQueryKeys } from "./thread-query-keys";
import { projectThreadsQueryOptions } from "./useProjectThreads";
import { convergeWorkProjection } from "./work-projection-cache";
import {
  refreshWorksSnapshot,
  repairWorksSnapshot,
  workFromSnapshot,
} from "./works-projection-acquisition";

export type ThreadWorkProjectionCursor = { seq: string; workId: string | null };

export type ThreadWorkConvergence =
  | { source: "confirmed"; projectId: string; result: RebindThreadWorkResponse }
  | { source: "projected"; seq: string; signal: WorkContextProjectionSignal }
  | {
      source: "reconciled";
      projectId: string;
      threadId: string;
      previousWorkId: string | null;
      workId: string | null;
    };

export type ThreadProjectionInvalidation = {
  threadId: string;
  projectId: string;
  refreshLists: boolean;
  skipSnapshot?: boolean;
};

const compareSeq = (left: string, right: string) => {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

export function invalidateThreadKeys(
  client: QueryClient,
  threadId: string,
  skipSnapshot: boolean,
): Promise<void> {
  const snapshotKey = threadQueryKeys.snapshot(threadId);
  return client.invalidateQueries({
    queryKey: threadQueryKeys.thread(threadId),
    predicate: skipSnapshot
      ? ({ queryKey }) => queryKey.join("/") !== snapshotKey.join("/")
      : undefined,
  });
}

export function invalidateThreadProjectionDependencies(
  client: QueryClient,
  input: ThreadProjectionInvalidation,
): void {
  void invalidateThreadKeys(client, input.threadId, input.skipSnapshot === true);
  void invalidateProjectChatFeed(client, input.projectId);
  if (input.refreshLists) {
    void client.invalidateQueries({
      queryKey: projectQueryKeys.threads(input.projectId),
      exact: true,
    });
    void repairWorksSnapshot(client, input.projectId);
  }
}

function patchSnapshot(client: QueryClient, threadId: string, workId: string | null): void {
  client.setQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId), (current) =>
    current ? { ...current, thread: { ...current.thread, workId } } : current,
  );
}

export function convergeThreadWorkBinding(
  client: QueryClient,
  transition: ThreadWorkConvergence,
  accountSignal?: AbortSignal,
): void {
  if (accountSignal?.aborted) return;
  if (transition.source === "projected") {
    const { seq, signal } = transition;
    const cursorKey = threadQueryKeys.workProjectionCursor(signal.threadId);
    const cursor = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey);
    if (cursor && compareSeq(seq, cursor.seq) <= 0) return;
    notifyManager.batch(() => {
      if (accountSignal?.aborted) return;
      const projectedWorkId = signal.scope.workId;
      const catalog = client.getQueryData<ListWorksResponse>(
        projectQueryKeys.works(signal.projectId),
      );
      const work = projectedWorkId ? workFromSnapshot(catalog, projectedWorkId) : null;
      client.setQueryData(cursorKey, { seq, workId: work?.id ?? projectedWorkId });
      if (work) {
        patchThreadInProjectCaches(client, signal.threadId, {
          workId: work.id,
          work: { id: work.id, title: work.name },
        });
        patchSnapshot(client, signal.threadId, work.id);
      }
      invalidateThreadProjectionDependencies(client, {
        threadId: signal.threadId,
        projectId: signal.projectId,
        refreshLists: false,
      });
      convergeWorkProjection(client, { kind: "binding", projectId: signal.projectId });
    });
    return;
  }

  const projectId = transition.projectId;
  const threadId =
    transition.source === "confirmed" ? transition.result.threadId : transition.threadId;
  notifyManager.batch(() => {
    if (accountSignal?.aborted) return;
    if (transition.source === "confirmed") {
      const { result } = transition;
      const catalog = client.getQueryData<ListWorksResponse>(projectQueryKeys.works(projectId));
      const afterWork = workFromSnapshot(catalog, result.after.workId);
      const afterWorkId = afterWork?.id ?? result.after.workId;
      if (afterWork) {
        patchThreadInProjectCaches(client, threadId, {
          workId: afterWork.id,
          work: { id: afterWork.id, title: afterWork.name },
        });
      }
      patchSnapshot(client, threadId, afterWorkId);
      invalidateThreadProjectionDependencies(client, { threadId, projectId, refreshLists: false });
      convergeWorkProjection(client, { kind: "binding", projectId });
      return;
    }

    const workId = transition.workId;
    const snapshotWorkId = client.getQueryData<ThreadSnapshotResponse>(
      threadQueryKeys.snapshot(threadId),
    )?.thread.workId;
    const before =
      transition.previousWorkId !== null
        ? transition.previousWorkId
        : snapshotWorkId === undefined
          ? workId
          : snapshotWorkId;
    if (before === workId) return;
    patchSnapshot(client, threadId, workId);
    invalidateThreadProjectionDependencies(client, {
      threadId,
      projectId,
      refreshLists: false,
      skipSnapshot: true,
    });
    convergeWorkProjection(client, { kind: "binding", projectId });
  });
}

export class ThreadWorkOutcomeUnconfirmedError extends Error {
  constructor(cause?: unknown) {
    super("The thread Work outcome could not be confirmed", { cause });
    this.name = "ThreadWorkOutcomeUnconfirmedError";
  }
}

export async function readStableThreadWorkBinding(
  client: QueryClient,
  input: { projectId: string; threadId: string; previousWorkId: string | null },
  accountSignal?: AbortSignal,
): Promise<{ threads: ThreadListItem[]; catalog: ListWorksResponse; workId: string | null }> {
  const cursorKey = threadQueryKeys.workProjectionCursor(input.threadId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (accountSignal?.aborted) throw new ThreadWorkOutcomeUnconfirmedError(accountSignal.reason);
    const before = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
    try {
      await client.cancelQueries({
        queryKey: projectQueryKeys.threads(input.projectId),
        exact: true,
      });
      const [threads, catalog] = await Promise.all([
        client.fetchQuery({ ...projectThreadsQueryOptions(client, input.projectId), staleTime: 0 }),
        refreshWorksSnapshot(client, input.projectId),
      ]);
      if (accountSignal?.aborted) throw accountSignal.reason;
      const after = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
      if (before !== after) continue;
      const workId = threads.find(({ id }) => id === input.threadId)?.workId ?? null;
      convergeThreadWorkBinding(client, { source: "reconciled", ...input, workId }, accountSignal);
      return { threads, catalog, workId };
    } catch (cause) {
      throw new ThreadWorkOutcomeUnconfirmedError(cause);
    }
  }
  throw new ThreadWorkOutcomeUnconfirmedError();
}
