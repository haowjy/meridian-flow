/** Canonical convergence and causal-read boundary for a thread's Work binding. */
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
import { listProjectThreads, listProjectWorks } from "@/client/api/projects-api";
import { invalidateProjectHomeFeed, invalidateWorkThreads } from "./project-invalidation";
import {
  isProjectContextTreeKey,
  isProjectWorkDerivedKey,
  isWorkScopedProjectContextTreeKey,
  projectQueryKeys,
} from "./project-query-keys";
import { patchThreadInProjectCaches } from "./project-thread-cache";
import { threadQueryKeys } from "./thread-query-keys";

export type ThreadWorkProjectionCursor = { seq: string; workId: string };

export type ThreadWorkConvergence =
  | { source: "confirmed"; projectId: string; result: RebindThreadWorkResponse }
  | { source: "projected"; seq: string; signal: WorkContextProjectionSignal }
  | {
      source: "reconciled";
      projectId: string;
      threadId: string;
      previousWorkId: string | null;
      threads: ThreadListItem[];
      catalog: ListWorksResponse;
    };

export type ThreadProjectionInvalidation = {
  threadId: string;
  projectId: string;
  refreshLists: boolean;
  workIds: ReadonlySet<string> | "all";
  contextTrees: "work-scoped" | "all";
};

const compareSeq = (left: string, right: string) => {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

export function invalidateThreadProjectionDependencies(
  client: QueryClient,
  input: ThreadProjectionInvalidation,
): void {
  const ids = input.workIds === "all" ? undefined : input.workIds;
  void client.invalidateQueries({ queryKey: threadQueryKeys.thread(input.threadId) });
  void invalidateProjectHomeFeed(client, input.projectId);
  if (input.refreshLists) {
    void client.invalidateQueries({
      queryKey: projectQueryKeys.threads(input.projectId),
      exact: true,
    });
    void client.invalidateQueries({
      queryKey: projectQueryKeys.works(input.projectId),
      exact: true,
    });
  }
  void client.invalidateQueries({
    predicate: ({ queryKey }) => isProjectWorkDerivedKey(queryKey, input.projectId, ids),
  });
  void client.invalidateQueries({
    predicate: ({ queryKey }) =>
      input.contextTrees === "all"
        ? isProjectContextTreeKey(queryKey, input.projectId)
        : isWorkScopedProjectContextTreeKey(queryKey, input.projectId, ids),
  });
}

function patchSnapshot(client: QueryClient, threadId: string, workId: string): void {
  client.setQueryData<ThreadSnapshotResponse>(threadQueryKeys.snapshot(threadId), (current) =>
    current ? { ...current, thread: { ...current.thread, workId } } : current,
  );
}

export function convergeThreadWorkBinding(
  client: QueryClient,
  transition: ThreadWorkConvergence,
): void {
  if (transition.source === "projected") {
    const { seq, signal } = transition;
    const cursorKey = threadQueryKeys.workProjectionCursor(signal.threadId);
    const cursor = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey);
    if (cursor && compareSeq(seq, cursor.seq) <= 0) return;
    notifyManager.batch(() => {
      client.setQueryData(cursorKey, { seq, workId: signal.workId });
      const catalog = client.getQueryData<ListWorksResponse>(
        projectQueryKeys.works(signal.projectId),
      );
      const work = catalog?.works.find(({ id }) => id === signal.workId);
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
        refreshLists: true,
        workIds: "all",
        contextTrees: "work-scoped",
      });
    });
    return;
  }

  const projectId = transition.projectId;
  const threadId =
    transition.source === "confirmed" ? transition.result.threadId : transition.threadId;
  notifyManager.batch(() => {
    if (transition.source === "confirmed") {
      const { result } = transition;
      patchThreadInProjectCaches(client, threadId, {
        workId: result.work.id,
        work: { id: result.work.id, title: result.work.name },
      });
      patchSnapshot(client, threadId, result.work.id);
      client.setQueryData<ListWorksResponse>(projectQueryKeys.works(projectId), (current) => {
        if (!current) return current;
        const known = current.works.some(({ id }) => id === result.work.id);
        return {
          ...current,
          works: known
            ? current.works.map((work) => (work.id === result.work.id ? result.work : work))
            : [...current.works, result.work],
        };
      });
      invalidateThreadProjectionDependencies(client, {
        threadId,
        projectId,
        refreshLists: true,
        workIds: new Set([result.previousWorkId, result.work.id]),
        contextTrees: "work-scoped",
      });
      void invalidateWorkThreads(client, projectId);
      return;
    }

    client.setQueryData(projectQueryKeys.threads(projectId), transition.threads);
    client.setQueryData(projectQueryKeys.works(projectId), transition.catalog);
    const row = transition.threads.find(({ id }) => id === threadId);
    if (row?.workId) patchSnapshot(client, threadId, row.workId);
    const ids = new Set([transition.previousWorkId, row?.workId].filter(Boolean) as string[]);
    invalidateThreadProjectionDependencies(client, {
      threadId,
      projectId,
      refreshLists: false,
      workIds: ids.size ? ids : "all",
      contextTrees: "work-scoped",
    });
    void invalidateWorkThreads(client, projectId);
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
): Promise<{ threads: ThreadListItem[]; catalog: ListWorksResponse; workId: string | null }> {
  const cursorKey = threadQueryKeys.workProjectionCursor(input.threadId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
    try {
      await Promise.all([
        client.cancelQueries({ queryKey: projectQueryKeys.threads(input.projectId), exact: true }),
        client.cancelQueries({ queryKey: projectQueryKeys.works(input.projectId), exact: true }),
      ]);
      const [threads, catalog] = await Promise.all([
        listProjectThreads(input.projectId),
        listProjectWorks(input.projectId, { status: "all" }),
      ]);
      const after = client.getQueryData<ThreadWorkProjectionCursor>(cursorKey)?.seq ?? null;
      if (before !== after) continue;
      convergeThreadWorkBinding(client, { source: "reconciled", ...input, threads, catalog });
      return {
        threads,
        catalog,
        workId: threads.find(({ id }) => id === input.threadId)?.workId ?? null,
      };
    } catch (cause) {
      throw new ThreadWorkOutcomeUnconfirmedError(cause);
    }
  }
  throw new ThreadWorkOutcomeUnconfirmedError();
}
