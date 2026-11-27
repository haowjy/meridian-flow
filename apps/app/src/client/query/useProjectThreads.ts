import type { ThreadListItem } from "@meridian/contracts/protocol";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { listProjectThreads } from "@/client/api/projects-api";
import { useCommands } from "@/client/commands/driver-context";
import { projectChatDrafts } from "./draft-commands";
import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";
import { applyThreadRenameFence, captureThreadRenameFence } from "./thread-rename-command";

export function projectThreadsQueryOptions(client: QueryClient, projectId: string) {
  return {
    queryKey: projectQueryKeys.threads(projectId),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const fence = captureThreadRenameFence(client, projectId);
      return listProjectThreads(projectId, { signal }).then((threads) =>
        applyThreadRenameFence(client, projectId, threads, fence),
      );
    },
    staleTime: 30_000,
  };
}

export function useProjectThreads(
  projectId: string,
  options?: { enabled?: boolean },
): {
  threads: ThreadListItem[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const client = useQueryClient();
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      ...projectThreadsQueryOptions(client, projectId),
      enabled: projectReadEnabled(options?.enabled ?? true),
    }),
  );

  const records = useCommands();
  const threads = useMemo(() => (data ? projectChatDrafts(records, data) : data), [records, data]);
  return { threads, isError, isFetching, refetch };
}
