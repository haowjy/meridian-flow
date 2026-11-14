/** React Query ownership for a project's restorable document trash. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { projectReadEnabled } from "@/client/creation/project-read-gate";
import { getDocumentTrash, getTrashedDocument } from "../api/projects-api";
import { projectQueryKeys } from "./project-query-keys";
import { useTreeList } from "./useProjectTree";

/**
 * The list of entries stays a server query (when each was deleted and when it will be purged are
 * the server's facts), but what is in Trash is a fact of the project's list: it is read again
 * whenever the list changes, whoever made the change.
 */
export function useDocumentTrash(projectId: string) {
  const queryClient = useQueryClient();
  const { snapshot } = useTreeList(projectId ? { kind: "project", projectId } : null);
  const version = useRef(snapshot?.version);
  const changed = snapshot?.version;
  useEffect(() => {
    if (version.current === changed) return;
    version.current = changed;
    void queryClient.invalidateQueries(
      { queryKey: projectQueryKeys.documentTrash(projectId), exact: true },
      { cancelRefetch: false },
    );
  }, [changed, projectId, queryClient]);
  return useQuery({
    queryKey: projectQueryKeys.documentTrash(projectId),
    queryFn: ({ signal }) => getDocumentTrash(projectId, { signal }),
    staleTime: 30_000,
  });
}

export function useTrashedDocument(projectId: string, documentId: string | null) {
  return useQuery({
    queryKey: projectQueryKeys.trashedDocument(projectId, documentId ?? ""),
    queryFn: ({ signal }) => getTrashedDocument(projectId, documentId as string, { signal }),
    enabled: projectReadEnabled(documentId !== null),
    staleTime: 30_000,
  });
}
