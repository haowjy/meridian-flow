/** HTTP client for a Work's pending-changes reads. */
import type {
  DocumentDraftHintsResponse,
  DraftItemsResponse,
  WorkDraftsResponse,
} from "@meridian/contracts/drafts";
import { apiProjectDocumentDraftsPath, apiProjectDraftsPath } from "@meridian/contracts/protocol";

import { getJson } from "./http-client";

/**
 * One draft's items, one row per document.
 * `readAt` is when the read started, the time its rows speak for.
 */
export type OwnerDraftList = DraftItemsResponse & { readAt: number };
export async function listOwnerDrafts(projectId: string, owner: string): Promise<OwnerDraftList> {
  const readAt = Date.now();
  return {
    ...(await getJson<DraftItemsResponse>(apiProjectDraftsPath(projectId, owner))),
    readAt,
  };
}

export function listDocumentDraftHints(
  projectId: string,
  documentId: string,
): Promise<DocumentDraftHintsResponse> {
  return getJson<DocumentDraftHintsResponse>(apiProjectDocumentDraftsPath(projectId, documentId));
}

/** A Work's drafts that are not deleted. */
export function listWorkDrafts(workId: string): Promise<WorkDraftsResponse> {
  return getJson<WorkDraftsResponse>(`/api/works/${workId}/drafts`);
}
