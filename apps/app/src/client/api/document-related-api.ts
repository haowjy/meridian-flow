/** HTTP client for the chats that worked on a document and the pages it links to. */
import { apiProjectDocumentRelatedPath, type DocumentRelated } from "@meridian/contracts/protocol";

import { getJson } from "./http-client";

export function fetchDocumentRelated(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentRelated> {
  return getJson<DocumentRelated>(
    apiProjectDocumentRelatedPath(projectId, documentId),
    signal ? { signal } : undefined,
  );
}
