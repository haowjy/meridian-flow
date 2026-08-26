/** Render-time projection of one immutable feed item through normalized user state. */
import type { ProjectChatItem } from "@meridian/contracts/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { projectQueryKeys } from "./project-query-keys";
import {
  getFavoriteCommandView,
  getThreadUserStateRecord,
  projectThreadUserState,
} from "./thread-user-state-commands";

export function useProjectChatUserState(projectId: string, item: ProjectChatItem) {
  const client = useQueryClient();
  const { data: record } = useQuery({
    queryKey: projectQueryKeys.threadUserState(projectId, item.id),
    queryFn: () => Promise.resolve(getThreadUserStateRecord(client, projectId, item)),
    initialData: () => getThreadUserStateRecord(client, projectId, item),
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return {
    item: projectThreadUserState(item, record),
    favorite: getFavoriteCommandView(record),
  };
}
