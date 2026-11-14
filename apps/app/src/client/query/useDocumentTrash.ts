/** React Query ownership for a project's restorable document trash. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import { useAccountId } from "@/features/project/context/account-feature-context";
import { getDocumentTrash, getTrashedDocument } from "../api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { listIsComplete, useTreeList } from "./useProjectTree";

/**
 * What is in Trash is a fact of the lists: an entry shows while its node is trashed in the
 * replay, so a restore leaves Trash at once and a refused one comes back. The query keeps what
 * the server owns (the entry's retention) and is read again whenever the list changes.
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
      { queryKey: projectQueryKeys.documentTrash(projectId), exact: true },
      { cancelRefetch: false },
    );
  }, [changed, projectId, queryClient]);
  const query = useQuery({
    queryKey: projectQueryKeys.documentTrash(projectId),
    queryFn: ({ signal }) => getDocumentTrash(projectId, { signal }),
    staleTime: 30_000,
  });
  const documents = query.data?.documents;
  const data = useMemo(() => {
    if (!documents) return undefined;
    return {
      documents: documents.filter((entry) => {
        const list = entry.scheme === "user" ? account : project;
        if (!list.session || !list.snapshot || !listIsComplete(list.snapshot.status)) return true;
        const node = list.session.replay().nodes.get(entry.documentId);
        return node?.trashed === true && !node.purged;
      }),
    };
    // `version` is the replay's input
  }, [documents, account, project, account.snapshot?.version, project.snapshot?.version]);
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
