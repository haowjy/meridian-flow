/** HTTP client for the chats that worked on a document and the pages it links to. */
import { apiProjectDocumentRelatedPath, type DocumentRelated } from "@meridian/contracts/protocol";

import { getJson, httpErrorStatus } from "./http-client";

/** A document live no longer has (a draft can still show one deleted live) has nothing related. */
export async function fetchDocumentRelated(
  projectId: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<DocumentRelated> {
  try {
    return await getJson<DocumentRelated>(
      apiProjectDocumentRelatedPath(projectId, documentId),
      signal ? { signal } : undefined,
    );
  } catch (error) {
    if (httpErrorStatus(error) === 404) return { chats: [], mentions: [] };
    throw error;
  }
}
