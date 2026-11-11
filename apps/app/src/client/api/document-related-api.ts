/** HTTP client for the chats that worked on a document and the pages it links to. */
import { apiProjectDocumentRelatedPath, type DocumentRelated } from "@meridian/contracts/protocol";

import { getJson, httpErrorStatus, isMeridianApiError } from "./http-client";

/**
 * A document live no longer has (a draft can still show one deleted live) has nothing related.
 * The file policy answers that with a 404 that carries no code, the same as for a document the
 * writer can't read, so existence stays hidden; a coded 404 (`project_deleted`) is a failure.
 */
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
    if (httpErrorStatus(error) === 404 && !isMeridianApiError(error))
      return { chats: [], mentions: [] };
    throw error;
  }
}
