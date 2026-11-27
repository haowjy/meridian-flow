import { useQuery } from "@tanstack/react-query";

import { fetchDocumentProperties } from "../api/document-properties-api";
import { projectQueryKeys } from "./project-query-keys";

export function useDocumentProperties(projectId: string, documentId: string) {
  return useQuery({
    queryKey: projectQueryKeys.documentProperties(projectId, documentId),
    queryFn: ({ signal }) => fetchDocumentProperties(projectId, documentId, signal),
    staleTime: 5 * 60_000,
  });
}
