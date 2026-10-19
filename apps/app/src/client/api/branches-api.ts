/** HTTP client for draft-review read endpoints. */
import type {
  DocumentDraftHintsResponse,
  DraftPreviewResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/branches";
import {
  apiProjectDocumentBranchesPath,
  apiProjectWorkBranchesPath,
  apiProjectWorkDocumentDraftPath,
} from "@meridian/contracts/protocol";

import { getJson } from "./http-client";

export async function listWorkBranchDrafts(
  projectId: string,
  workId: string,
): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiProjectWorkBranchesPath(projectId, workId));
}

export function listDocumentDraftHints(
  projectId: string,
  documentId: string,
): Promise<DocumentDraftHintsResponse> {
  return getJson<DocumentDraftHintsResponse>(apiProjectDocumentBranchesPath(projectId, documentId));
}

export async function getDraftPreview(
  projectId: string,
  workId: string,
  documentId: string,
  itemKey: string,
  signal?: AbortSignal,
): Promise<DraftPreviewResponse> {
  const params = new URLSearchParams({ itemKey });
  const preview = await getJson<DraftPreviewResponse>(
    `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}?${params}`,
    { signal },
  );
  if (preview.status === "active" && !preview.reviewRoomName) {
    throw new Error("Draft preview response is missing reviewRoomName");
  }
  if (preview.status === "active" && typeof preview.draftGeneration !== "number") {
    throw new Error("Draft preview response is missing draftGeneration");
  }
  return preview;
}
