/**
 * drafts-api — HTTP client for AI document draft review endpoints.
 *
 * Typed wrappers for listing active thread drafts, reading live-vs-draft
 * markdown previews, and applying/discarding a draft without exposing route
 * strings to query hooks.
 */
import type {
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
  DraftApplyRequest,
  DraftApplyResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListResponse,
} from "@meridian/contracts/drafts";
import {
  apiProjectWorkDocumentDraftApplyChangesPath,
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
  const response: unknown = await postJson<unknown>(
    apiProjectWorkDocumentDraftApplyPath(projectId, workId, documentId),
    request,
  );
  if (
    typeof response !== "object" ||
    response === null ||
    !("status" in response) ||
    response.status !== "applied" ||
    !("draftId" in response) ||
    response.draftId !== request.draftId
  ) {
    throw new Error("Draft Apply response did not prove the requested draft was applied");
  }
  return response as DraftApplyResponse;
}

export async function applyDraftChanges(
  projectId: string,
  workId: string,
  documentId: string,
  request: DraftApplyChangesRequest,
): Promise<DraftApplyChangesResponse> {
  const response = await postJson<DraftApplyChangesResponse>(
    apiProjectWorkDocumentDraftApplyChangesPath(projectId, workId, documentId),
    request,
  );
  if (
    response.draftId !== request.draftId ||
    !["applied", "stale", "gone", "draft_only", "incomplete_class"].includes(response.status)
  )
    throw new Error("Draft change Apply response did not identify the requested draft");
  if (
    response.status === "applied" &&
    (!Array.isArray(response.operationIds) ||
      response.operationIds.length !== new Set(request.operationIds).size ||
      request.operationIds.some((id) => !response.operationIds.includes(id)) ||
      !Array.isArray(response.closureClassIds) ||
      response.closureClassIds.length === 0)
  )
    throw new Error("Draft change Apply response did not prove the requested changes were applied");
  return response;
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
