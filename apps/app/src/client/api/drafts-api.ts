/**
 * drafts-api — HTTP client for AI document draft review endpoints.
 *
 * Typed wrappers for listing active thread drafts, reading live-vs-draft
 * markdown previews, and applying/discarding a draft without exposing route
 * strings to query hooks.
 */
import type {
  DraftApplyRequest,
  DraftApplyResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import {
  apiProjectWorkDocumentDraftApplyPath,
  apiProjectWorkDocumentDraftDiscardPath,
  apiProjectWorkDocumentDraftPath,
  apiProjectWorkDraftsPath,
} from "@meridian/contracts/protocol";

import { getJson, postJson } from "./http-client";

export async function listWorkDrafts(
  projectId: string,
  workId: string,
): Promise<ThreadDraftListResponse> {
  return getJson<ThreadDraftListResponse>(apiProjectWorkDraftsPath(projectId, workId));
}

export async function getDraftPreview(
  projectId: string,
  workId: string,
  documentId: string,
  draftId: string,
): Promise<DraftPreviewResponse> {
  const params = new URLSearchParams({ draftId });
  const preview = await getJson<DraftPreviewResponse>(
    `${apiProjectWorkDocumentDraftPath(projectId, workId, documentId)}?${params}`,
  );
  if (preview.status === "active" && !preview.reviewRoomName) {
    throw new Error("Draft preview response is missing reviewRoomName");
  }
  return preview;
}

export async function applyDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftApplyRequest,
): Promise<DraftApplyResponse> {
  return postJson<DraftApplyResponse>(
    apiProjectWorkDocumentDraftApplyPath(projectId, workId, documentId),
    request,
  );
}

export async function discardDraft(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftDiscardRequest,
): Promise<DraftDiscardResponse> {
  return postJson<DraftDiscardResponse>(
    apiProjectWorkDocumentDraftDiscardPath(projectId, workId, documentId),
    request,
  );
}
