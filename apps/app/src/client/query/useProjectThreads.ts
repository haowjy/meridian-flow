import type { ThreadListItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listProjectThreads } from "@/client/api/projects-api";
import { useCommands } from "@/client/commands/driver-context";
import { projectChats } from "./chat-commands";
import { projectChatDrafts } from "./draft-commands";
import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { projectReadEnabled } from "./project-read-gate";

export function projectThreadsQueryOptions(projectId: string) {
  return {
    queryKey: projectQueryKeys.threads(projectId),
    queryFn: ({ signal }: { signal: AbortSignal }) => listProjectThreads(projectId, { signal }),
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
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      ...projectThreadsQueryOptions(projectId),
      enabled: projectReadEnabled(options?.enabled ?? true),
    }),
  );

  const records = useCommands();
  const threads = useMemo(
    () => (data ? projectChats(records, projectChatDrafts(records, data)) : data),
    [records, data],
  );
  return { threads, isError, isFetching, refetch };
}
