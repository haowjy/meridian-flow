import type { ThreadDraftListResponse } from "@meridian/contracts/branches";
import { LIVE } from "@meridian/project-tree";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { useTreeList } from "@/client/query/useProjectTree";

/**
 * A live delete or restore of a drafted document changes what its owner's drafts list says
 * (`deletedLive`, "Deleted" on its rows in Changes and the draft dock), and no draft hint
 * follows it: each cached owner list that disagrees with the live tree is read again.
 */
export function useLiveDeleteDraftRefresh(projectId: string, accountId: string) {
  const queryClient = useQueryClient();
  const project = useTreeList({ kind: "project", projectId });
  const account = useTreeList({ kind: "account", userId: accountId });
  useEffect(() => {
    const lists = [project.session, account.session].flatMap((session) =>
      session ? [session.replay(LIVE).nodes] : [],
    );
    if (lists.length === 0) return;
    const trashed = (id: string) => {
      for (const nodes of lists) {
        const node = nodes.get(id);
        if (node) return node.trashed;
      }
      return null;
    };
    for (const [queryKey, data] of queryClient.getQueriesData<ThreadDraftListResponse>({
      queryKey: projectQueryKeys.ownerDraftsOf(projectId),
    })) {
      const stale = data?.items.some((item) => {
        if (item.isNew || item.tree?.deleted) return false;
        const live = trashed(item.documentId);
        return live !== null && live !== item.deletedLive;
      });
      if (stale) void queryClient.invalidateQueries({ queryKey, exact: true });
    }
  }, [
    projectId,
    queryClient,
    project.snapshot,
    account.snapshot,
    project.session,
    account.session,
  ]);
}
