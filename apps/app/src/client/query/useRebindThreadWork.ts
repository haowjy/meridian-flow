/**
 * useRebindThreadWork — authoritative thread Work mutation and cache convergence.
 */
import type { ListWorksResponse } from "@meridian/contracts/protocol";
import type { RebindThreadWorkResponse } from "@meridian/contracts/works";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

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

export function useRebindThreadWork(projectId: string, threadId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (workId: string) => rebindThreadWork(threadId, { workId }),
    onSuccess: (result) => convergeThreadWork(client, projectId, result),
  });
}
