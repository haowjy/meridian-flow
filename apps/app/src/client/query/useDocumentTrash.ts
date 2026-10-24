/** React Query ownership for a project's restorable document trash. */
import { useQuery } from "@tanstack/react-query";
import { getDocumentTrash, getTrashedDocument } from "../api/projects-api";
import { projectQueryKeys } from "./project-query-keys";

export function useDocumentTrash(projectId: string) {
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
    enabled: documentId !== null,
    staleTime: 30_000,
  });
}
