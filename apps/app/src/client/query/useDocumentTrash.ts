/** React Query ownership for a project's Trash entries. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { getTrash, getTrashedDocument } from "../api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { listIsComplete, useTreeList } from "./useProjectTree";

/**
 * What is in Trash is a fact of the lists: an entry shows while the replay has a delete of its
 * node in force, so a restore leaves Trash at once and a refused one comes back. A deleted folder
 * that something brought back stands in the tree and stays an entry for the rest of what it took.
 * The query keeps what the server owns (the entry's time and retention) and is read again
 * whenever the list changes.
 */
export function useDocumentTrash(projectId: string) {
  const queryClient = useQueryClient();
  const accountId = useAccountId();
  const project = useTreeList(projectId ? { kind: "project", projectId } : null);
  const account = useTreeList({ kind: "account", userId: accountId });
  const version = useRef<string | undefined>(undefined);
  const changed = `${project.snapshot?.version}:${account.snapshot?.version}`;
  useEffect(() => {
    if (version.current === changed) return;
    // The first read is the query's own.
    const first = version.current === undefined;
    version.current = changed;
    if (first) return;
    void queryClient.invalidateQueries(
      { queryKey: projectQueryKeys.trash(projectId), exact: true },
      { cancelRefetch: false },
    );
  }, [changed, projectId, queryClient]);
  const query = useQuery({
    queryKey: projectQueryKeys.trash(projectId),
    queryFn: ({ signal }) => getTrash(projectId, { signal }),
    staleTime: 30_000,
  });
  const listed = query.data?.entries;
  const data = useMemo(() => {
    if (!listed) return undefined;
    return {
      entries: listed.filter((entry) => {
        const list = entry.scheme === "user" ? account : project;
        if (!list.session || !list.snapshot || !listIsComplete(list.snapshot.status)) return true;
        return list.session.replay().trash.some((each) => each.node === entry.nodeId);
      }),
    };
    // `version` is the replay's input
  }, [listed, account, project, account.snapshot?.version, project.snapshot?.version]);
  return { data, isError: query.isError, isPending: query.isPending, refetch: query.refetch };
}

export function useTrashedDocument(projectId: string, documentId: string | null) {
  return useQuery({
    queryKey: projectQueryKeys.trashedDocument(projectId, documentId ?? ""),
    queryFn: ({ signal }) => getTrashedDocument(projectId, documentId as string, { signal }),
    enabled: projectReadEnabled(documentId !== null),
    staleTime: 30_000,
  });
}
