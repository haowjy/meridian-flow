/** The chats that edited or read a document, and the pages it mentions: one read per document. */
import { useQuery } from "@tanstack/react-query";

import { fetchDocumentRelated } from "../api/document-related-api";
import { projectQueryKeys } from "./project-query-keys";

export function useDocumentRelated(
  projectId: string,
  documentId: string | null,
  options?: { enabled?: boolean },
) {
  return useQuery({
    queryKey: projectQueryKeys.documentRelated(projectId, documentId ?? ""),
    queryFn: ({ signal }) => fetchDocumentRelated(projectId, documentId as string, signal),
    staleTime: 15_000,
    enabled: (options?.enabled ?? true) && documentId !== null,
  });
}
