/** HTTP client for a Work's pending-changes reads. */
import type { DocumentDraftHintsResponse, DraftItemsResponse } from "@meridian/contracts/drafts";
import { apiProjectDocumentDraftsPath, apiProjectDraftsPath } from "@meridian/contracts/protocol";

import { getJson } from "./http-client";

/**
 * The drafts one owner (`work:<id>` or `lineage:<root>`) has pending, one row per document.
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
