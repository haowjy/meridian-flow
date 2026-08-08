/**
 * useRebindThreadWork — authoritative thread Work mutation and cache convergence.
 */
import type { ListWorksResponse } from "@meridian/contracts/protocol";
import type {
  RebindThreadWorkResponse,
  WorkContextProjectionSignal,
} from "@meridian/contracts/works";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { isMeridianApiError } from "@/client/api/http-client";
import { listProjectThreads, listProjectWorks } from "@/client/api/projects-api";
import { rebindThreadWork } from "@/client/api/threads-api";
import { projectQueryKeys } from "./project-query-keys";
import { patchThreadInProjectCaches } from "./project-thread-cache";
import { threadQueryKeys } from "./thread-query-keys";

export function convergeThreadWork(
  client: QueryClient,
  projectId: string,
  result: RebindThreadWorkResponse,
): void {
  patchThreadInProjectCaches(client, result.threadId, {
    workId: result.work.id,
    work: { id: result.work.id, title: result.work.name },
  });
  client.setQueryData<ListWorksResponse>(projectQueryKeys.works(projectId), (current) =>
    current
      ? {
          ...current,
          defaultWorkId: result.preferenceChanged ? result.work.id : current.defaultWorkId,
          works: current.works.map((work) => (work.id === result.work.id ? result.work : work)),
        }
      : current,
  );

  void Promise.all([
    client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) }),
    client.invalidateQueries({ queryKey: projectQueryKeys.works(projectId) }),
    client.invalidateQueries({ queryKey: threadQueryKeys.thread(result.threadId) }),
    client.invalidateQueries({
      queryKey: projectQueryKeys.workDrafts(projectId, result.previousWorkId),
    }),
    client.invalidateQueries({ queryKey: projectQueryKeys.workDrafts(projectId, result.work.id) }),
    client.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        return (
          key[0] === "projects" &&
          key[1] === projectId &&
          (key[2] === "context" || (key[2] === "works" && key.includes("documents")))
        );
      },
    }),
  ]);
}

/** Converge an open client after another actor committed the binding. */
export function convergeProjectedThreadWork(
  client: QueryClient,
  signal: WorkContextProjectionSignal,
): void {
  const catalog = client.getQueryData<ListWorksResponse>(projectQueryKeys.works(signal.projectId));
  const work = catalog?.works.find((candidate) => candidate.id === signal.workId);
  if (work) {
    patchThreadInProjectCaches(client, signal.threadId, {
      workId: work.id,
      work: { id: work.id, title: work.name },
    });
  }

  void Promise.all([
    client.invalidateQueries({ queryKey: projectQueryKeys.threads(signal.projectId) }),
    client.invalidateQueries({ queryKey: projectQueryKeys.works(signal.projectId) }),
    client.invalidateQueries({ queryKey: threadQueryKeys.thread(signal.threadId) }),
    client.invalidateQueries({ queryKey: threadQueryKeys.snapshot(signal.threadId) }),
    client.invalidateQueries({
      predicate: (query) =>
        query.queryKey[0] === "projects" && query.queryKey[1] === signal.projectId,
    }),
  ]);
}

export function useRebindThreadWork(projectId: string, threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (workId: string) => {
      try {
        return await rebindThreadWork(threadId, { workId });
      } catch (cause) {
        // Structured API failures are authoritative refusals. Transport and
        // decoding failures are ambiguous because the write may have committed.
        if (isMeridianApiError(cause)) throw cause;

        const committed = await reconcileThreadWorkMutation(client, projectId, threadId, workId);
        throw new ThreadWorkReconciliationError(cause, committed);
      }
    },
    onSuccess: (result) => convergeThreadWork(client, projectId, result),
  });
}

/** Read the binding causally after an ambiguous mutation, never through query deduplication. */
export async function reconcileThreadWorkMutation(
  client: QueryClient,
  projectId: string,
  threadId: string,
  workId: string,
): Promise<boolean> {
  const threadsKey = projectQueryKeys.threads(projectId);
  const worksKey = projectQueryKeys.works(projectId);

  // A query that started before the mutation cannot be allowed to populate the
  // cache after this point. The direct reads below are deliberately outside
  // fetchQuery so TanStack cannot return an existing retryer promise.
  await Promise.all([
    client.cancelQueries({ queryKey: threadsKey }),
    client.cancelQueries({ queryKey: worksKey }),
  ]);
  const [threads, works] = await Promise.all([
    listProjectThreads(projectId),
    listProjectWorks(projectId, { status: "all" }),
  ]);
  client.setQueryData(threadsKey, threads);
  client.setQueryData(worksKey, works);
  await client.invalidateQueries({ queryKey: threadQueryKeys.thread(threadId) });
  return threads.find((thread) => thread.id === threadId)?.workId === workId;
}

export class ThreadWorkReconciliationError extends Error {
  readonly committed: boolean;

  constructor(cause: unknown, committed: boolean) {
    super("Thread Work mutation outcome reconciled", { cause });
    this.name = "ThreadWorkReconciliationError";
    this.committed = committed;
  }
}
